import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ClerkUserInfoService } from '../../auth/clerk-user-info.service';
import {
  cleanMemberParagraphs,
  cleanMemberTitle,
  hasVisibleText,
} from '../../membership/member-text';
import { JOIN_CLAIM_STALE_MS } from '../../membership/membership.service';
import { ModerationLogService } from '../../moderation/moderation-log.service';
import {
  Claim,
  type ClaimDocument,
  type ClaimStatus,
  MAX_CLAIM_MESSAGE_LENGTH,
  MAX_CLAIM_REASON_LENGTH,
  SYSTEM_CLAIMS_ACTOR,
} from '../../social/schemas/claim.schema';
import {
  SocialProfile,
  type SocialProfileDocument,
} from '../../social/schemas/social-profile.schema';
import { describeFailure } from '../comments/comment-limits';
import {
  CANNOT_CHECK_ACCOUNT,
  CommentWritersService,
} from '../comments/comment-writers';
import { MembersService } from '../members.service';
import type { Viewer } from '../profile-access';
import {
  type AdminClaimView,
  type ClaimBlock,
  type ClaimPageRow,
  type ClaimRow,
  isClaimable,
  type MyClaims,
  type MyClaimView,
  myClaimView,
  pageView,
} from './claim-views';

export const CLAIM_NOT_FOUND = 'That request does not exist.';
export const NOT_CLAIMABLE = 'This page already belongs to a member.';
export const CLAIM_MESSAGE_EMPTY =
  'Please tell the admins how they can tell this page is yours.';
export const CLAIM_MESSAGE_TOO_LONG = `A request can hold at most ${MAX_CLAIM_MESSAGE_LENGTH.toLocaleString('en-US')} characters.`;
export const CLAIM_REASON_TOO_LONG = `A reason can hold at most ${MAX_CLAIM_REASON_LENGTH} characters.`;
export const VERIFY_EMAIL_TO_CLAIM =
  'Please confirm your email address before asking to claim a page.';
export const HAS_PAGE =
  'This account already has a member page, so it cannot claim another.';
export const HAS_PENDING =
  'You already have a request waiting. Withdraw it first to ask for another page.';
export const CLAIM_DECIDED = 'This request has already been decided.';
export const CLAIM_BUSY =
  'This request is being approved right now. Reload in a moment.';
export const OWN_CLAIM = 'Another admin must decide your own request.';
export const PAGE_GONE =
  'That page no longer exists, so the request was rejected.';
export const PAGE_TAKEN =
  'That page now belongs to another member, so the request was rejected.';
export const CLAIMANT_HAS_PAGE =
  'The person asking already has a member page of their own. Reject this request, or ask them first.';

/** What the claimant reads when the site, not an admin, rejected a request. */
export const SITE_REASON_TAKEN = 'This page now belongs to another member.';
export const SITE_REASON_GONE = 'This page no longer exists.';

/**
 * An approval holding its lock this long without finishing died; another
 * decision may then take over, after checking whether it bound the page.
 */
export const APPROVE_LOCK_STALE_MS = 2 * 60_000;

/** A claimant's newest requests shown; older ones stay in the log. */
export const MY_CLAIMS_SHOWN = 20;

/** Requests per page of the admin queue. */
export const ADMIN_CLAIMS_SHOWN = 200;

const CLAIM_PAGE_FIELDS = { slug: 1, displayName: 1, deletedAt: 1 };

/** MongoDB duplicate-key error (unique index violation). */
export function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

/** A claim id from a URL; anything else is the same "no such request". */
export function parseClaimId(value: string): Types.ObjectId {
  if (!/^[0-9a-f]{24}$/i.test(value)) {
    throw new NotFoundException(CLAIM_NOT_FOUND);
  }
  return new Types.ObjectId(value);
}

function staleLockCutoff() {
  return new Date(Date.now() - APPROVE_LOCK_STALE_MS);
}

/** Matches a pending claim no live approval holds. */
function unlockedPending() {
  return {
    status: 'pending' as const,
    $or: [
      { approvingAt: { $exists: false } },
      { approvingAt: { $lt: staleLockCutoff() } },
    ],
  };
}

/**
 * Claims on imported member pages (plan D5, Chunk 11).
 *
 * - Who may ask: a signed-in account with a confirmed email and NO member
 *   page of its own, of any kind (one page per login, for ever; Q2 "claim:
 *   no" for anonymous accounts holds because an account is anonymous only
 *   through a page). One waiting request per account (a unique index).
 * - Which pages: imported (`source: migrated`), approved, not deleted, with
 *   no owner, that the claimant can see at least by name. Anything else the
 *   claimant may not see is the same 404 as a page that does not exist.
 * - Who decides: an admin (the real Clerk role), never on their own request.
 * - Approving binds the page with a conditional write that only succeeds
 *   while the page has no owner, and the partial unique index on
 *   `ownerUserId` refuses a login that already owns a page. Whatever the
 *   timing, a page gets one owner and a login one page.
 * - Every step is in the append-only moderation log.
 */
@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);

  constructor(
    @InjectModel(Claim.name)
    private readonly claimModel: Model<ClaimDocument>,
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    private readonly members: MembersService,
    private readonly writers: CommentWritersService,
    private readonly clerk: ClerkUserInfoService,
    private readonly log: ModerationLogService,
  ) {}

  /** The reader's own requests, and whether they may ask now. */
  async mine(userId: string): Promise<MyClaims> {
    const rows = (await this.claimModel
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(MY_CLAIMS_SHOWN)
      .lean()
      .exec()) as unknown as ClaimRow[];
    const pages = await this.pagesOf(rows);
    const claims: MyClaimView[] = rows.map((row) =>
      myClaimView(row, pages.get(String(row.profileId))),
    );
    const block = await this.blockFor(
      userId,
      rows.some((row) => row.status === 'pending'),
    );
    return {
      mayClaim: block === undefined,
      ...(block ? { block } : {}),
      claims,
    };
  }

  /**
   * Asks to own an imported page.
   *
   * @throws NotFoundException for a page the claimant may not see
   * @throws ConflictException for a page with an owner, or a request waiting
   * @throws ForbiddenException without a confirmed email, or with a page
   * @throws BadRequestException for an empty or too long message
   */
  async request(
    viewer: Viewer & { userId: string },
    slug: string,
    rawMessage: string,
  ): Promise<MyClaimView> {
    const message = cleanMemberParagraphs(rawMessage).trim();
    if (!hasVisibleText(message)) {
      throw new BadRequestException(CLAIM_MESSAGE_EMPTY);
    }
    if (message.length > MAX_CLAIM_MESSAGE_LENGTH) {
      throw new BadRequestException(CLAIM_MESSAGE_TOO_LONG);
    }
    const { profile } = await this.members.findVisible(slug, viewer);
    if (!isClaimable(profile)) {
      throw new ConflictException(NOT_CLAIMABLE);
    }
    await this.requireEligible(viewer.userId);

    let row: ClaimRow;
    try {
      const created = await this.claimModel.create({
        profileId: profile._id,
        userId: viewer.userId,
        message,
        status: 'pending',
      });
      row = created.toObject() as unknown as ClaimRow;
    } catch (error) {
      if (isDuplicateKey(error)) throw new ConflictException(HAS_PENDING);
      throw error;
    }
    try {
      await this.log.record({
        actorUserId: viewer.userId,
        action: 'claim.requested',
        targetType: 'claim',
        targetId: String(row._id),
        reason: 'A member asked to claim an imported page.',
        details: { profileId: String(profile._id), slug: profile.slug },
      });
    } catch (error) {
      // No request without its record: the member can simply ask again.
      await this.claimModel
        .deleteOne({ _id: row._id, status: 'pending' })
        .exec()
        .catch(() => undefined);
      throw error;
    }
    return myClaimView(row, {
      _id: profile._id,
      slug: profile.slug,
      displayName: profile.displayName,
    });
  }

  /**
   * The claimant takes back a request that is still waiting.
   *
   * @throws NotFoundException unless it is theirs
   * @throws ConflictException when it was decided, or is being approved
   */
  async withdraw(userId: string, claimId: string) {
    const id = parseClaimId(claimId);
    const claim = await this.readClaim(id);
    if (claim?.userId !== userId) throw new NotFoundException(CLAIM_NOT_FOUND);
    await this.settleStaleApproval(claim);
    const now = new Date();
    const result = await this.claimModel
      .updateOne(
        { _id: id, userId, ...unlockedPending() },
        {
          $set: { status: 'withdrawn', decidedBy: userId, decidedAt: now },
          $unset: { approvingAt: 1 },
        },
      )
      .exec();
    if (result.modifiedCount !== 1) await this.refuseUndecidable(id);
    await this.record(
      userId,
      'claim.withdrawn',
      claim,
      'Withdrawn by the member.',
    );
    return { withdrawn: true };
  }

  /** The admin queue: one status, oldest first. */
  async adminList(status: ClaimStatus): Promise<{ claims: AdminClaimView[] }> {
    const rows = (await this.claimModel
      .find({ status })
      .sort({ createdAt: 1 })
      .limit(ADMIN_CLAIMS_SHOWN)
      .lean()
      .exec()) as unknown as ClaimRow[];
    const pages = await this.pagesOf(rows);
    const identities = new Map<
      string,
      { email?: string; emailVerified?: boolean }
    >();
    for (const userId of new Set(rows.map((row) => row.userId))) {
      try {
        const identity = await this.clerk.getIdentity(userId);
        identities.set(userId, {
          ...(identity.email ? { email: identity.email } : {}),
          emailVerified: identity.emailVerified,
        });
      } catch (error) {
        this.logger.warn(
          `Could not read a claimant's account: ${describeFailure(error)}`,
        );
      }
    }
    const fresh = staleLockCutoff();
    return {
      claims: rows.map(
        (row): AdminClaimView => ({
          claimId: String(row._id),
          status: row.status,
          approving:
            row.status === 'pending' &&
            row.approvingAt !== undefined &&
            row.approvingAt >= fresh,
          message: row.message,
          requestedAt: row.createdAt.toISOString(),
          ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
          decidedBySite: row.decidedBy === SYSTEM_CLAIMS_ACTOR,
          ...(row.reason ? { reason: row.reason } : {}),
          claimant: { userId: row.userId, ...identities.get(row.userId) },
          ...pageView(pages.get(String(row.profileId))),
        }),
      ),
    };
  }

  /**
   * Approves a request: the page becomes the claimant's. The other requests
   * waiting for that page are rejected by the site.
   *
   * Order: take the claim's short lock; bind the page only while it has no
   * owner; mark the claim approved; record it; reject the rest. An approval
   * that dies after binding is finished by the next decision on that claim
   * (`settleStaleApproval`), so a bound page always ends with an approved
   * claim.
   *
   * @throws NotFoundException for no such request
   * @throws ForbiddenException on the admin's own request
   * @throws ConflictException when decided, busy, or the page or the claimant
   *   can no longer be bound
   */
  async approve(adminId: string, claimId: string) {
    const id = parseClaimId(claimId);
    const claim = await this.decidableClaim(adminId, id);
    if (await this.settleStaleApproval(claim)) {
      throw new ConflictException(CLAIM_DECIDED);
    }
    const lockAt = new Date();
    const locked = await this.claimModel
      .updateOne(
        { _id: id, ...unlockedPending() },
        { $set: { approvingAt: lockAt } },
      )
      .exec();
    if (locked.modifiedCount !== 1) await this.refuseUndecidable(id);

    let bound: { modifiedCount: number };
    try {
      bound = await this.profileModel
        .updateOne(
          {
            _id: claim.profileId,
            source: 'migrated',
            ownerUserId: { $exists: false },
            deletedAt: { $exists: false },
          },
          { $set: { ownerUserId: claim.userId } },
        )
        .exec();
    } catch (error) {
      await this.releaseLock(id, lockAt);
      if (isDuplicateKey(error)) throw new ConflictException(CLAIMANT_HAS_PAGE);
      throw error;
    }
    if (bound.modifiedCount !== 1) {
      const page = await this.profileModel
        .findOne({ _id: claim.profileId })
        .select({ ownerUserId: 1, deletedAt: 1 })
        .lean()
        .exec();
      // Already the claimant's (an earlier approval bound it): just finish.
      if (page?.ownerUserId !== claim.userId) {
        const gone = !page || Boolean(page.deletedAt);
        await this.rejectBySite(
          claim,
          gone ? SITE_REASON_GONE : SITE_REASON_TAKEN,
          { approvingAt: lockAt },
        );
        throw new ConflictException(gone ? PAGE_GONE : PAGE_TAKEN);
      }
    }
    await this.finishApproval(claim, adminId);
    return { approved: true };
  }

  /**
   * @throws NotFoundException for no such request
   * @throws ForbiddenException on the admin's own request
   * @throws ConflictException when decided, or while it is being approved
   * @throws BadRequestException for a reason over its limit
   */
  async reject(adminId: string, claimId: string, rawReason?: string) {
    const id = parseClaimId(claimId);
    const reason = cleanMemberTitle(rawReason ?? '');
    if (reason.length > MAX_CLAIM_REASON_LENGTH) {
      throw new BadRequestException(CLAIM_REASON_TOO_LONG);
    }
    const claim = await this.decidableClaim(adminId, id);
    if (await this.settleStaleApproval(claim)) {
      throw new ConflictException(CLAIM_DECIDED);
    }
    const result = await this.claimModel
      .updateOne(
        { _id: id, ...unlockedPending() },
        {
          $set: {
            status: 'rejected',
            decidedBy: adminId,
            decidedAt: new Date(),
            ...(hasVisibleText(reason) ? { reason } : {}),
          },
          $unset: { approvingAt: 1 },
        },
      )
      .exec();
    if (result.modifiedCount !== 1) await this.refuseUndecidable(id);
    await this.record(
      adminId,
      'claim.rejected',
      claim,
      hasVisibleText(reason) ? reason : 'Rejected without a reason.',
    );
    return { rejected: true };
  }

  /** @throws NotFoundException / ForbiddenException / ConflictException */
  private async decidableClaim(adminId: string, id: Types.ObjectId) {
    const claim = await this.readClaim(id);
    if (!claim) throw new NotFoundException(CLAIM_NOT_FOUND);
    if (claim.userId === adminId) throw new ForbiddenException(OWN_CLAIM);
    if (claim.status !== 'pending') throw new ConflictException(CLAIM_DECIDED);
    return claim;
  }

  private async readClaim(id: Types.ObjectId) {
    return (await this.claimModel
      .findOne({ _id: id })
      .lean()
      .exec()) as unknown as ClaimRow | null;
  }

  /**
   * A claim whose approval died: if that approval bound the page, finish it
   * (the page is the claimant's whatever the claim row says).
   *
   * @returns true when it finished an approval here
   */
  private async settleStaleApproval(claim: ClaimRow): Promise<boolean> {
    if (claim.status !== 'pending' || claim.approvingAt === undefined) {
      return false;
    }
    if (claim.approvingAt >= staleLockCutoff()) return false;
    const page = await this.profileModel
      .findOne({ _id: claim.profileId })
      .select({ ownerUserId: 1 })
      .lean()
      .exec();
    if (page?.ownerUserId !== claim.userId) return false;
    await this.finishApproval(claim, SYSTEM_CLAIMS_ACTOR);
    return true;
  }

  /** Marks a bound claim approved, records it, rejects the page's others. */
  private async finishApproval(claim: ClaimRow, decidedBy: string) {
    const done = await this.claimModel
      .updateOne(
        { _id: claim._id, status: 'pending' },
        {
          $set: { status: 'approved', decidedBy, decidedAt: new Date() },
          $unset: { approvingAt: 1 },
        },
      )
      .exec();
    if (done.modifiedCount === 1) {
      await this.record(
        decidedBy,
        'claim.approved',
        claim,
        'The page now belongs to the member who asked.',
      );
    }
    const others = (await this.claimModel
      .find({
        profileId: claim.profileId,
        status: 'pending',
        _id: { $ne: claim._id },
      })
      .lean()
      .exec()) as unknown as ClaimRow[];
    for (const other of others) {
      await this.rejectBySite(other, SITE_REASON_TAKEN, {});
    }
  }

  /**
   * Rejects a waiting claim on the site's behalf. `lock` names the lock this
   * caller holds, or `{}` for a claim nobody is approving.
   */
  private async rejectBySite(
    claim: ClaimRow,
    reason: string,
    lock: { approvingAt?: Date },
  ) {
    const result = await this.claimModel
      .updateOne(
        { _id: claim._id, status: 'pending', ...lock },
        {
          $set: {
            status: 'rejected',
            decidedBy: SYSTEM_CLAIMS_ACTOR,
            decidedAt: new Date(),
            reason,
          },
          $unset: { approvingAt: 1 },
        },
      )
      .exec();
    if (result.modifiedCount === 1) {
      await this.record(SYSTEM_CLAIMS_ACTOR, 'claim.rejected', claim, reason);
    }
  }

  /** Lets go of this approval's lock, only if it is still ours. */
  private async releaseLock(id: Types.ObjectId, lockAt: Date) {
    await this.claimModel
      .updateOne(
        { _id: id, status: 'pending', approvingAt: lockAt },
        { $unset: { approvingAt: 1 } },
      )
      .exec();
  }

  /** Why a decision on a claim that existed a moment ago did not land. */
  private async refuseUndecidable(id: Types.ObjectId): Promise<never> {
    const now = await this.readClaim(id);
    if (now?.status === 'pending') throw new ConflictException(CLAIM_BUSY);
    throw new ConflictException(CLAIM_DECIDED);
  }

  private async record(
    actorUserId: string,
    action: string,
    claim: ClaimRow,
    reason: string,
  ) {
    await this.log.record({
      actorUserId,
      action,
      targetType: 'claim',
      targetId: String(claim._id),
      reason,
      details: { profileId: String(claim.profileId), userId: claim.userId },
    });
  }

  /** The claimed pages, by id. */
  private async pagesOf(rows: ClaimRow[]): Promise<Map<string, ClaimPageRow>> {
    if (rows.length === 0) return new Map();
    const pages = (await this.profileModel
      .find({ _id: { $in: [...new Set(rows.map((row) => row.profileId))] } })
      .select(CLAIM_PAGE_FIELDS)
      .lean()
      .exec()) as unknown as ClaimPageRow[];
    return new Map(pages.map((page) => [String(page._id), page]));
  }

  /** Why this account may not ask now, or nothing when it may. */
  private async blockFor(
    userId: string,
    hasPending: boolean,
  ): Promise<ClaimBlock | undefined> {
    if (await this.ownsPage(userId)) return 'has-page';
    if (hasPending) return 'has-pending';
    try {
      return (await this.writers.emailVerified(userId))
        ? undefined
        : 'verify-email';
    } catch (error) {
      this.logger.warn(
        `Could not read an email status: ${describeFailure(error)}`,
      );
      return 'cannot-check';
    }
  }

  /**
   * @throws ForbiddenException with a page, or without a confirmed email
   * @throws ConflictException with a request waiting
   * @throws ServiceUnavailableException when the account cannot be checked
   */
  private async requireEligible(userId: string) {
    if (await this.ownsPage(userId)) throw new ForbiddenException(HAS_PAGE);
    const waiting = await this.claimModel
      .exists({ userId, status: 'pending' })
      .exec();
    if (waiting) throw new ConflictException(HAS_PENDING);
    let verified: boolean;
    try {
      verified = await this.writers.emailVerified(userId);
    } catch (error) {
      // A rejected account (Clerk's 404) stays what it is.
      if (error instanceof HttpException && error.getStatus() === 401) {
        throw error;
      }
      this.logger.warn(
        `Could not check a claimant's email: ${describeFailure(error)}`,
      );
      throw new ServiceUnavailableException(CANNOT_CHECK_ACCOUNT);
    }
    if (!verified) throw new ForbiddenException(VERIFY_EMAIL_TO_CLAIM);
  }

  /**
   * Any page of this login counts, deleted ones too (one page per login, for
   * ever), except a join that died before finishing (its row is swept by the
   * next join).
   */
  private async ownsPage(userId: string): Promise<boolean> {
    const page = await this.profileModel
      .findOne({ ownerUserId: userId })
      .select({ reviewStatus: 1, createdAt: 1 })
      .lean()
      .exec();
    if (!page) return false;
    return !(
      page.reviewStatus === 'claiming' &&
      (page.createdAt as Date) < new Date(Date.now() - JOIN_CLAIM_STALE_MS)
    );
  }
}
