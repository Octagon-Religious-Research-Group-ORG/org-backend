import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model, Types } from 'mongoose';
import { AdminInboxService } from '../../admin-inbox/admin-inbox.service';
import { inTransaction } from '../../db/transactions';
import {
  cleanMemberParagraphs,
  hasVisibleText,
} from '../../membership/member-text';
import { ModerationLogService } from '../../moderation/moderation-log.service';
import {
  MAX_REMOVAL_REASON_LENGTH,
  type ProfileReviewStatus,
  type ProfileVisibility,
  type RemovableStatus,
  SLUG_PATTERN,
  SocialProfile,
  type SocialProfileDocument,
} from '../../social/schemas/social-profile.schema';

export const MEMBERS_PAGE_SIZE = 50;
export const PAGE_NOT_FOUND = 'That page does not exist.';
export const OWN_PAGE = 'Another admin must decide about your own page.';
export const NOT_PENDING = 'That page is not waiting for approval.';
export const NOT_REMOVABLE = 'That page is already removed.';
export const NOT_REMOVED = 'That page is not removed.';
export const REASON_NEEDED = 'Please give a reason.';
export const REASON_TOO_LONG = `A reason can hold at most ${MAX_REMOVAL_REASON_LENGTH} characters.`;
export const PAGE_CHANGED =
  'The page changed while you were deciding. Please look again.';

/** The statuses the Members section filters by. */
export const MEMBER_FILTERS = [
  'all',
  'approved',
  'pending',
  'removed',
] as const;
export type MemberFilter = (typeof MEMBER_FILTERS)[number];

/** A member page as the dashboard lists it (admins only). */
export interface AdminMemberView {
  slug: string;
  displayName: string;
  reviewStatus: Exclude<ProfileReviewStatus, 'claiming'>;
  visibility: ProfileVisibility;
  anonymous: boolean;
  source: 'migrated' | 'native';
  /** The owner's Clerk id; absent for an imported page not yet claimed. */
  ownerUserId?: string;
  createdAt?: string;
  /** Existing pages whose name reads like this one (for approving). */
  similarNameOf?: string[];
  removal?: {
    at: string;
    by: string;
    reason: string;
    previousStatus: RemovableStatus;
  };
}

interface PageRow {
  _id: Types.ObjectId;
  slug: string;
  displayName: string;
  reviewStatus?: ProfileReviewStatus;
  visibility: ProfileVisibility;
  anonymous?: boolean;
  source: 'migrated' | 'native';
  ownerUserId?: string;
  createdAt?: Date;
  similarNameOf?: string[];
  removal?: {
    at: Date;
    by: string;
    reason: string;
    previousStatus: RemovableStatus;
  };
}

const LIST_FIELDS = {
  slug: 1,
  displayName: 1,
  reviewStatus: 1,
  visibility: 1,
  anonymous: 1,
  source: 1,
  ownerUserId: 1,
  createdAt: 1,
  similarNameOf: 1,
  removal: 1,
};

/** Characters with a meaning in a regular expression, escaped. */
export function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The Members section of the admin dashboard (Chunk 12): find a page, approve
 * or reject a new one, and remove or restore a page.
 *
 * Removing is a SOFT removal (plan §2b: ORG keeps everything for at least 5
 * years): the page leaves the site for everyone but the admins, nothing is
 * deleted, and a restore puts back the status it had. What a removal means
 * for the rest of the site follows from the page no longer being approved,
 * as for a page that was never approved:
 * - the owner can no longer edit, comment or vote, and cannot start a new
 *   page on that account;
 * - their comments on other pages stay, signed "A member" instead of their
 *   name; comments on their own page are hidden with it;
 * - their beliefs leave the "agreed by 2+" list; votes on them are kept;
 * - the votes THEY cast stay counted (the Chunk 10 rule; a question for the
 *   owner).
 *
 * Rejecting a new page is a removal from `pending`, so it can be restored to
 * pending. Every decision, its log entry and the closing of the page's inbox
 * notice happen in one transaction. An admin never decides about their own
 * page.
 */
@Injectable()
export class AdminMembersService {
  constructor(
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly log: ModerationLogService,
    private readonly inbox: AdminInboxService,
  ) {}

  async list(
    filter: MemberFilter,
    query: string | undefined,
    page: number,
  ): Promise<{ members: AdminMemberView[]; hasMore: boolean }> {
    const text = (query ?? '').trim();
    const conditions: Record<string, unknown> = {
      deletedAt: { $exists: false },
      reviewStatus:
        filter === 'all'
          ? { $ne: 'claiming' }
          : filter === 'approved'
            ? { $in: ['approved', null] }
            : filter,
    };
    if (text) {
      const pattern = new RegExp(escapeRegex(text), 'i');
      conditions.$or = [{ displayName: pattern }, { slug: pattern }];
    }
    const rows = (await this.profileModel
      .find(conditions)
      .select(LIST_FIELDS)
      .sort(
        filter === 'pending'
          ? { createdAt: 1, _id: 1 }
          : { displayName: 1, _id: 1 },
      )
      .skip((page - 1) * MEMBERS_PAGE_SIZE)
      .limit(MEMBERS_PAGE_SIZE + 1)
      .lean()
      .exec()) as unknown as PageRow[];
    return {
      members: rows.slice(0, MEMBERS_PAGE_SIZE).map(memberView),
      hasMore: rows.length > MEMBERS_PAGE_SIZE,
    };
  }

  /** @throws NotFoundException / ForbiddenException / ConflictException */
  async approve(adminId: string, slug: string) {
    await inTransaction(this.connection, async (session) => {
      const page = await this.decidable(adminId, slug, session);
      if (page.reviewStatus !== 'pending') {
        throw new ConflictException(NOT_PENDING);
      }
      await this.change(
        page,
        { reviewStatus: 'pending' },
        { $set: { reviewStatus: 'approved' } },
        session,
      );
      await this.record(
        adminId,
        'page.approved',
        page,
        'Admin approved the page.',
        {},
        session,
      );
      await this.inbox.closePageNotice(page._id, adminId, session);
    });
    return { reviewStatus: 'approved' as const };
  }

  /** A new page refused: removed from `pending`, so it can be restored. */
  async reject(adminId: string, slug: string, rawReason: string) {
    return this.takeOff(adminId, slug, rawReason, true);
  }

  async remove(adminId: string, slug: string, rawReason: string) {
    return this.takeOff(adminId, slug, rawReason, false);
  }

  /** Puts a removed page back to the status it had. */
  async restore(adminId: string, slug: string, rawReason: string) {
    const reason = cleanReason(rawReason);
    const restoredTo = await inTransaction(this.connection, async (session) => {
      const page = await this.decidable(adminId, slug, session);
      if (page.reviewStatus !== 'removed' || !page.removal) {
        throw new ConflictException(NOT_REMOVED);
      }
      const back = page.removal.previousStatus;
      await this.change(
        page,
        { reviewStatus: 'removed' },
        { $set: { reviewStatus: back }, $unset: { removal: 1 } },
        session,
      );
      await this.record(
        adminId,
        'page.restored',
        page,
        reason,
        {
          restoredTo: back,
          removedBy: page.removal.by,
          removedAt: page.removal.at.toISOString(),
        },
        session,
      );
      return back;
    });
    return { reviewStatus: restoredTo };
  }

  private async takeOff(
    adminId: string,
    slug: string,
    rawReason: string,
    rejecting: boolean,
  ) {
    const reason = cleanReason(rawReason);
    await inTransaction(this.connection, async (session) => {
      const page = await this.decidable(adminId, slug, session);
      const from = page.reviewStatus ?? 'approved';
      if (rejecting && from !== 'pending') {
        throw new ConflictException(NOT_PENDING);
      }
      if (from !== 'pending' && from !== 'approved') {
        throw new ConflictException(NOT_REMOVABLE);
      }
      await this.change(
        page,
        // A row older than the field has none, and reads as approved.
        from === 'approved'
          ? { reviewStatus: { $in: ['approved', null] } }
          : { reviewStatus: from },
        {
          $set: {
            reviewStatus: 'removed',
            removal: {
              at: new Date(),
              by: adminId,
              reason,
              previousStatus: from,
            },
          },
        },
        session,
      );
      await this.record(
        adminId,
        rejecting ? 'page.rejected' : 'page.removed',
        page,
        reason,
        { previousStatus: from },
        session,
      );
      await this.inbox.closePageNotice(page._id, adminId, session);
    });
    return { reviewStatus: 'removed' as const };
  }

  /**
   * The page, read inside the transaction.
   *
   * @throws NotFoundException for an unknown, deleted or half-joined page
   * @throws ForbiddenException for the admin's own page
   */
  private async decidable(
    adminId: string,
    rawSlug: string,
    session: ClientSession,
  ): Promise<PageRow> {
    const slug = rawSlug.trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) throw new NotFoundException(PAGE_NOT_FOUND);
    const page = (await this.profileModel
      .findOne({
        slug,
        deletedAt: { $exists: false },
        reviewStatus: { $ne: 'claiming' },
      })
      .select(LIST_FIELDS)
      .session(session)
      .lean()
      .exec()) as unknown as PageRow | null;
    if (!page) throw new NotFoundException(PAGE_NOT_FOUND);
    if (page.ownerUserId === adminId) throw new ForbiddenException(OWN_PAGE);
    return page;
  }

  /** The conditional write; a page that moved meanwhile is a 409. */
  private async change(
    page: PageRow,
    expected: Record<string, unknown>,
    update: Record<string, unknown>,
    session: ClientSession,
  ) {
    const result = await this.profileModel
      .updateOne({ _id: page._id, ...expected }, update, {
        session,
        runValidators: true,
      })
      .exec();
    if (result.modifiedCount !== 1) throw new ConflictException(PAGE_CHANGED);
  }

  private async record(
    adminId: string,
    action: string,
    page: PageRow,
    reason: string,
    details: Record<string, unknown>,
    session: ClientSession,
  ) {
    await this.log.record(
      {
        actorUserId: adminId,
        action,
        targetType: 'member-page',
        targetId: String(page._id),
        reason,
        details: {
          slug: page.slug,
          ...(page.ownerUserId ? { ownerUserId: page.ownerUserId } : {}),
          ...details,
        },
      },
      session,
    );
  }
}

/**
 * A removal's reason, cleaned like a member's text.
 *
 * @throws BadRequestException when it is empty or too long
 */
export function cleanReason(raw: string): string {
  const reason = cleanMemberParagraphs(raw).trim();
  if (!hasVisibleText(reason)) throw new BadRequestException(REASON_NEEDED);
  if (reason.length > MAX_REMOVAL_REASON_LENGTH) {
    throw new BadRequestException(REASON_TOO_LONG);
  }
  return reason;
}

export function memberView(row: PageRow): AdminMemberView {
  const status = (row.reviewStatus ?? 'approved') as Exclude<
    ProfileReviewStatus,
    'claiming'
  >;
  return {
    slug: row.slug,
    displayName: row.displayName,
    reviewStatus: status,
    visibility: row.visibility,
    anonymous: row.anonymous ?? false,
    source: row.source,
    ...(row.ownerUserId ? { ownerUserId: row.ownerUserId } : {}),
    ...(row.createdAt ? { createdAt: row.createdAt.toISOString() } : {}),
    ...(status === 'pending' && row.similarNameOf?.length
      ? { similarNameOf: row.similarNameOf }
      : {}),
    ...(row.removal
      ? {
          removal: {
            at: row.removal.at.toISOString(),
            by: row.removal.by,
            reason: row.removal.reason,
            previousStatus: row.removal.previousStatus,
          },
        }
      : {}),
  };
}
