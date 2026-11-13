import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type Types } from 'mongoose';
import { isNearDuplicateName } from '../../membership/member-text';
import { ModerationLogService } from '../../moderation/moderation-log.service';
import { Claim, type ClaimDocument } from '../../social/schemas/claim.schema';
import {
  Comment,
  type CommentDocument,
} from '../../social/schemas/comment.schema';
import {
  SocialProfile,
  type SocialProfileDocument,
} from '../../social/schemas/social-profile.schema';
import {
  type ClaimPageRow,
  type LegacyCommentList,
  type LegacyCommentView,
  pageView,
} from './claim-views';
import { CLAIM_NOT_FOUND, OWN_CLAIM, parseClaimId } from './claims.service';

export const LINK_NEEDS_APPROVAL =
  'Imported comments can be linked once the request is approved.';
export const LINK_PAGE_GONE =
  'The claimed page no longer belongs to this member.';
export const LINK_ANONYMOUS =
  "This member's page uses a nickname. Linking would show their Pages name next to it, so it is off.";

/** Most imported comments listed at once; ORG has fewer than a hundred. */
export const MAX_LEGACY_LISTED = 2_000;

/** Characters of each comment shown so the admin can recognise it. */
export const EXCERPT_LENGTH = 300;

interface LegacyRow {
  commentId: string;
  profileId: Types.ObjectId;
  legacyAuthorName?: string;
  legacyCreatedAt?: Date;
  body: string;
  linkedUserId?: string;
}

/**
 * Linking imported comments to the member who wrote them (plan Q5, Chunk 11),
 * a separate admin step after a claim is approved.
 *
 * An imported comment's author is a name typed into Apple Pages, which
 * proves nothing, so a name match is only a hint: the admin picks each
 * comment. Linking changes no text, name or date; it only adds who the
 * comment is now known to be from (`linkedUserId`). Each link and unlink is
 * its own entry in the append-only moderation log.
 */
@Injectable()
export class LegacyLinksService {
  constructor(
    @InjectModel(Claim.name)
    private readonly claimModel: Model<ClaimDocument>,
    @InjectModel(Comment.name)
    private readonly commentModel: Model<CommentDocument>,
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    private readonly log: ModerationLogService,
  ) {}

  /**
   * Imported comments not linked to anyone else, those already linked to
   * this claimant first, then those whose Pages name reads like the page's.
   *
   * When linking is off (the page uses a nickname, or is gone) only the
   * comments already linked to this claimant are listed, so a link can
   * still be taken back.
   *
   * @throws NotFoundException / ForbiddenException / ConflictException as
   *   {@link approvedClaim}
   */
  async candidates(
    adminId: string,
    claimId: string,
  ): Promise<LegacyCommentList> {
    const claim = await this.approvedClaim(adminId, claimId);
    const userId = claim.userId;
    const page = await this.livePage(claim);
    const linkingOff = !page
      ? 'page-gone'
      : page.anonymous
        ? 'anonymous'
        : undefined;
    const rows = (await this.commentModel
      .find({
        source: 'migrated',
        $or: linkingOff
          ? [{ linkedUserId: userId }]
          : [
              { linkedUserId: userId },
              {
                linkedUserId: { $exists: false },
                removedAt: { $exists: false },
              },
            ],
      })
      .select({
        commentId: 1,
        profileId: 1,
        legacyAuthorName: 1,
        legacyCreatedAt: 1,
        body: 1,
        linkedUserId: 1,
      })
      .sort({ _id: 1 })
      .limit(MAX_LEGACY_LISTED + 1)
      .lean()
      .exec()) as unknown as LegacyRow[];
    const shown = rows.slice(0, MAX_LEGACY_LISTED);
    const pages = (await this.profileModel
      .find({ _id: { $in: [...new Set(shown.map((row) => row.profileId))] } })
      .select({ slug: 1, displayName: 1, deletedAt: 1 })
      .lean()
      .exec()) as unknown as ClaimPageRow[];
    const pageOf = new Map(pages.map((row) => [String(row._id), row]));
    const comments = shown.map((row): LegacyCommentView => {
      // The import always writes a name ("Unknown (Apple Pages)" at worst).
      const name = String(row.legacyAuthorName);
      return {
        commentId: row.commentId,
        ...pageView(pageOf.get(String(row.profileId))),
        name,
        ...(row.legacyCreatedAt
          ? { importedDate: row.legacyCreatedAt.toISOString() }
          : {}),
        excerpt: row.body.slice(0, EXCERPT_LENGTH),
        linked: row.linkedUserId === userId,
        nameMatches:
          page !== null && isNearDuplicateName(name, page.displayName),
      };
    });
    const rank = (view: LegacyCommentView) =>
      view.linked ? 0 : view.nameMatches ? 1 : 2;
    comments.sort((a, b) => rank(a) - rank(b));
    return {
      ...(page
        ? {
            owner: {
              slug: page.slug,
              displayName: page.displayName,
              anonymous: Boolean(page.anonymous),
            },
          }
        : {}),
      ...(linkingOff ? { linkingOff } : {}),
      comments,
      hasMore: rows.length > MAX_LEGACY_LISTED,
    };
  }

  /**
   * Links the picked imported comments to the claimant. One already linked
   * (to anyone), removed, or not imported is skipped and named.
   */
  async link(adminId: string, claimId: string, commentIds: string[]) {
    const claim = await this.approvedClaim(adminId, claimId);
    const userId = claim.userId;
    const page = await this.livePage(claim);
    if (!page) throw new ConflictException(LINK_PAGE_GONE);
    // Review round 1: "Real Name (now Nickname)" would unmask the member.
    if (page.anonymous) throw new ConflictException(LINK_ANONYMOUS);
    const linked: string[] = [];
    const skipped: string[] = [];
    for (const commentId of new Set(commentIds)) {
      const result = await this.commentModel
        .updateOne(
          {
            commentId,
            source: 'migrated',
            removedAt: { $exists: false },
            linkedUserId: { $exists: false },
          },
          {
            $set: {
              linkedUserId: userId,
              linkedAt: new Date(),
              linkedBy: adminId,
            },
          },
        )
        .exec();
      if (result.modifiedCount !== 1) {
        skipped.push(commentId);
        continue;
      }
      linked.push(commentId);
      await this.record(adminId, 'comment.legacy-linked', commentId, claim);
    }
    return { linked, skipped };
  }

  /**
   * Takes a link back: a wrong link must not stay, so this needs only the
   * approved claim, even once the member's page is gone or anonymous.
   */
  async unlink(adminId: string, claimId: string, commentIds: string[]) {
    const claim = await this.approvedClaim(adminId, claimId);
    const userId = claim.userId;
    const unlinked: string[] = [];
    const skipped: string[] = [];
    for (const commentId of new Set(commentIds)) {
      const result = await this.commentModel
        .updateOne(
          { commentId, source: 'migrated', linkedUserId: userId },
          { $unset: { linkedUserId: 1, linkedAt: 1, linkedBy: 1 } },
        )
        .exec();
      if (result.modifiedCount !== 1) {
        skipped.push(commentId);
        continue;
      }
      unlinked.push(commentId);
      await this.record(adminId, 'comment.legacy-unlinked', commentId, claim);
    }
    return { unlinked, skipped };
  }

  /**
   * An approved claim another admin may act on.
   *
   * @throws NotFoundException for no such request
   * @throws ForbiddenException on the admin's own request (review round 1)
   * @throws ConflictException unless it is approved
   */
  private async approvedClaim(adminId: string, claimId: string) {
    const claim = await this.claimModel
      .findOne({ _id: parseClaimId(claimId) })
      .lean()
      .exec();
    if (!claim) throw new NotFoundException(CLAIM_NOT_FOUND);
    if (claim.userId === adminId) throw new ForbiddenException(OWN_CLAIM);
    if (claim.status !== 'approved') {
      throw new ConflictException(LINK_NEEDS_APPROVAL);
    }
    return claim;
  }

  /** The page the claim bound, while it is still the claimant's and live. */
  private async livePage(claim: { profileId: Types.ObjectId; userId: string }) {
    return (await this.profileModel
      .findOne({
        _id: claim.profileId,
        ownerUserId: claim.userId,
        deletedAt: { $exists: false },
      })
      .select({ slug: 1, displayName: 1, anonymous: 1 })
      .lean()
      .exec()) as unknown as (ClaimPageRow & { anonymous?: boolean }) | null;
  }

  private async record(
    actorUserId: string,
    action: string,
    commentId: string,
    claim: { _id: Types.ObjectId; userId: string },
  ) {
    await this.log.record({
      actorUserId,
      action,
      targetType: 'comment',
      targetId: commentId,
      reason:
        action === 'comment.legacy-linked'
          ? 'Linked an imported comment to the member who claimed their page.'
          : 'Took back the link of an imported comment.',
      details: { claimId: String(claim._id), userId: claim.userId },
    });
  }
}
