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
import { type ClientSession, Model, Types } from 'mongoose';
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
export const OWN_CLAIM = 'Another admin must decide your own request.';
export const PAGE_GONE =
  'That page no longer exists, so the request was rejected.';
export const PAGE_TAKEN =
  'That page now belongs to another member, so the request was rejected.';
export const CLAIMANT_GONE =
  'The account that asked no longer exists. Reject this request.';
export const CLAIMANT_UNVERIFIED =
  'The person asking no longer has a confirmed email address. Ask them to confirm it, or reject this request.';
export const CLAIMANT_HAS_PAGE =
  'The person asking already has a member page of their own. Reject this request, or ask them first.';

export const CLAIMS_NEED_REPLICA_SET =
  "Claims need a replica-set database, and this server's database is not one. Please tell the site's maintainer.";

/** What the claimant reads when the site, not an admin, rejected a request. */
export const SITE_REASON_TAKEN = 'This page now belongs to another member.';
export const SITE_REASON_GONE = 'This page no longer exists.';

/** A claimant's newest requests shown; older ones stay in the log. */
export const MY_CLAIMS_SHOWN = 20;

/** Requests per page of the admin queue. */
export const ADMIN_CLAIMS_SHOWN = 200;

const CLAIM_PAGE_FIELDS = { slug: 1, displayName: 1, deletedAt: 1 };

/** Thrown inside the approval to abort it: the page cannot be bound. */
class PageNotBindable extends Error {}

/**
 * The database cannot run transactions: a standalone server (code 20,
 * IllegalOperation: "Transaction numbers are only allowed on a replica set
 * member or mongos"), or retryable writes unsupported. Claim decisions need
 * them, so they refuse plainly instead of failing with a bare 500.
 */
export function isTransactionUnsupported(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === 20 ||
    (typeof message === 'string' &&
      /replica set member or mongos|does not support retryable writes/i.test(
        message,
      ))
  );
}

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
 * - Approving binds the page, in one transaction with the claim's move to
 *   approved, with a conditional write that only succeeds while the page has
 *   no owner; the partial unique index on `ownerUserId` refuses a login that
 *   already owns a page. Whatever the timing, a page gets one owner, a login
 *   one page, and a bound page always has its approved claim.
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
    const page = {
      _id: profile._id,
      slug: profile.slug,
      displayName: profile.displayName,
    };
    // An approval of another request may have committed, and rejected the
    // page's other requests, between the check above and this insert
    // (review round 2): this one would then wait for ever on an owned page.
    if (await this.pageNowOwned(profile._id)) {
      const rejected = await this.rejectBySiteSafely(row, SITE_REASON_TAKEN);
      if (rejected) {
        return myClaimView(
          {
            ...row,
            status: 'rejected',
            decidedAt: rejected,
            reason: SITE_REASON_TAKEN,
          },
          page,
        );
      }
    }
    return myClaimView(row, page);
  }

  private async pageNowOwned(profileId: Types.ObjectId) {
    const now = await this.profileModel
      .findOne({ _id: profileId })
      .select({ ownerUserId: 1 })
      .lean()
      .exec();
    return Boolean(now?.ownerUserId);
  }

  /**
   * The site's rejection of one waiting request, never failing its caller:
   * a failure is logged, and the request stays for an admin (approving it
   * then finds the page taken and rejects it).
   *
   * @returns when it was rejected, or nothing when it was not
   */
  private async rejectBySiteSafely(
    claim: ClaimRow,
    reason: string,
  ): Promise<Date | undefined> {
    try {
      let at: Date | undefined;
      await this.inTransaction(async (session) => {
        at = await this.rejectBySite(claim, reason, session);
      });
      return at;
    } catch (error) {
      this.logger.warn(
        `Could not reject request ${String(claim._id)} for a taken page: ${describeFailure(error)}`,
      );
      return undefined;
    }
  }

  /**
   * The claimant takes back a request that is still waiting.
   *
   * @throws NotFoundException unless it is theirs
   * @throws ConflictException when it was decided
   */
  async withdraw(userId: string, claimId: string) {
    const id = parseClaimId(claimId);
    const claim = await this.readClaim(id);
    if (claim?.userId !== userId) throw new NotFoundException(CLAIM_NOT_FOUND);
    await this.decideAlone(
      claim,
      { status: 'withdrawn', decidedBy: userId },
      'claim.withdrawn',
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
    return {
      claims: rows.map(
        (row): AdminClaimView => ({
          claimId: String(row._id),
          status: row.status,
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
   * Approves a request: the page becomes the claimant's, and the page's other
   * waiting requests are rejected by the site.
   *
   * ONE transaction (review round 1, HIGH): the claim moves pending →
   * approved, the page is bound only while it is an approved imported page
   * with no owner, and the approval is logged (the page's other requests
   * are rejected right after it commits). Either all of it lands or none of it: a page is never bound to a
   * claim that is not approved, and "approved" is answered only when this
   * call's own change committed. A rejection or withdrawal racing it is a
   * write conflict: one of the two commits and the other finds the claim
   * decided. Needs a replica set (Atlas always is one).
   *
   * Before it, the claimant's account is checked again: it must still exist
   * and still have a confirmed email.
   *
   * @throws NotFoundException for no such request
   * @throws ForbiddenException on the admin's own request
   * @throws ConflictException when decided, when the claimant can no longer
   *   own it, or when the page went to someone else or is gone (the request
   *   is then rejected by the site)
   * @throws ServiceUnavailableException when the account cannot be checked
   */
  async approve(adminId: string, claimId: string) {
    const id = parseClaimId(claimId);
    const claim = await this.decidableClaim(adminId, id);
    await this.requireClaimantStillEligible(claim.userId);

    let refusal: 'taken' | 'gone' | undefined;
    await this.inTransaction(async (session) => {
      refusal = undefined;
      const now = new Date();
      let decided: { modifiedCount: number };
      try {
        decided = await this.claimModel
          .updateOne(
            { _id: id, status: 'pending' },
            {
              $set: { status: 'approved', decidedBy: adminId, decidedAt: now },
            },
            { session },
          )
          .exec();
      } catch (error) {
        // The page already has an approved claim (its unique index).
        if (!isDuplicateKey(error)) throw error;
        refusal = 'taken';
        throw new PageNotBindable();
      }
      if (decided.modifiedCount !== 1) {
        throw new ConflictException(CLAIM_DECIDED);
      }
      let bound: { modifiedCount: number };
      try {
        bound = await this.profileModel
          .updateOne(
            {
              _id: claim.profileId,
              source: 'migrated',
              reviewStatus: 'approved',
              ownerUserId: { $exists: false },
              deletedAt: { $exists: false },
            },
            { $set: { ownerUserId: claim.userId } },
            { session },
          )
          .exec();
      } catch (error) {
        if (isDuplicateKey(error)) {
          throw new ConflictException(CLAIMANT_HAS_PAGE);
        }
        throw error;
      }
      if (bound.modifiedCount !== 1) {
        const page = await this.profileModel
          .findOne({ _id: claim.profileId })
          .select({ deletedAt: 1 })
          .session(session)
          .lean()
          .exec();
        refusal = !page || page.deletedAt ? 'gone' : 'taken';
        // Abort: the claim's change above must not commit either.
        throw new PageNotBindable();
      }
      await this.record(
        adminId,
        'claim.approved',
        claim,
        'The page now belongs to the member who asked.',
        session,
      );
    }).catch((error: unknown) => {
      if (!(error instanceof PageNotBindable)) throw error;
    });

    if (refusal) {
      const gone = refusal === 'gone';
      await this.inTransaction(async (session) => {
        await this.rejectBySite(
          claim,
          gone ? SITE_REASON_GONE : SITE_REASON_TAKEN,
          session,
        );
      });
      throw new ConflictException(gone ? PAGE_GONE : PAGE_TAKEN);
    }
    await this.rejectOthers(claim);
    return { approved: true };
  }

  /**
   * After an approval committed, the page's other waiting requests are
   * rejected by the site, each in its own small transaction. Not inside the
   * approval: two approvals each writing the other's claim would hold each
   * other's documents and retry for ever (measured on a real replica set).
   * If this stops part-way, a later approval of one of them finds the page
   * taken and rejects it then.
   */
  private async rejectOthers(claim: ClaimRow) {
    // The approval has committed: nothing here may turn it into an error.
    let others: ClaimRow[];
    try {
      others = (await this.claimModel
        .find({
          profileId: claim.profileId,
          status: 'pending',
          _id: { $ne: claim._id },
        })
        .lean()
        .exec()) as unknown as ClaimRow[];
    } catch (error) {
      this.logger.warn(
        `Could not list the other requests for page ${String(claim.profileId)}: ${describeFailure(error)}`,
      );
      return;
    }
    for (const other of others) {
      await this.rejectBySiteSafely(other, SITE_REASON_TAKEN);
    }
  }

  /**
   * @throws NotFoundException for no such request
   * @throws ForbiddenException on the admin's own request
   * @throws ConflictException when decided
   * @throws BadRequestException for a reason over its limit
   */
  async reject(adminId: string, claimId: string, rawReason?: string) {
    const id = parseClaimId(claimId);
    const reason = cleanMemberTitle(rawReason ?? '');
    if (reason.length > MAX_CLAIM_REASON_LENGTH) {
      throw new BadRequestException(CLAIM_REASON_TOO_LONG);
    }
    const claim = await this.decidableClaim(adminId, id);
    const given = hasVisibleText(reason);
    await this.decideAlone(
      claim,
      {
        status: 'rejected',
        decidedBy: adminId,
        ...(given ? { reason } : {}),
      },
      'claim.rejected',
      given ? reason : 'Rejected without a reason.',
    );
    return { rejected: true };
  }

  /**
   * A decision that binds nothing (reject, withdraw): the claim moves from
   * pending, and its log entry is written, in one transaction.
   *
   * @throws ConflictException when the claim was decided meanwhile
   */
  private async decideAlone(
    claim: ClaimRow,
    change: { status: ClaimStatus; decidedBy: string; reason?: string },
    action: string,
    logReason: string,
  ) {
    await this.inTransaction(async (session) => {
      const result = await this.claimModel
        .updateOne(
          { _id: claim._id, status: 'pending' },
          { $set: { ...change, decidedAt: new Date() } },
          { session },
        )
        .exec();
      if (result.modifiedCount !== 1) {
        throw new ConflictException(CLAIM_DECIDED);
      }
      await this.record(change.decidedBy, action, claim, logReason, session);
    });
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
   * The claimant's account, checked again at approval (review LOW b): it
   * still exists and its email is still confirmed. A confirmed answer may be
   * up to a minute old (the Chunk 9 cache); an unconfirmed one never is.
   *
   * @throws ConflictException when the account is gone or unconfirmed
   * @throws ServiceUnavailableException when Clerk cannot be asked
   */
  private async requireClaimantStillEligible(userId: string) {
    let verified: boolean;
    try {
      verified = await this.writers.emailVerified(userId);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 401) {
        throw new ConflictException(CLAIMANT_GONE);
      }
      this.logger.warn(
        `Could not check a claimant's account: ${describeFailure(error)}`,
      );
      throw new ServiceUnavailableException(CANNOT_CHECK_ACCOUNT);
    }
    if (!verified) throw new ConflictException(CLAIMANT_UNVERIFIED);
  }

  /** Rejects a waiting claim on the site's behalf, inside a transaction. */
  private async rejectBySite(
    claim: ClaimRow,
    reason: string,
    session: ClientSession,
  ): Promise<Date | undefined> {
    const decidedAt = new Date();
    const result = await this.claimModel
      .updateOne(
        { _id: claim._id, status: 'pending' },
        {
          $set: {
            status: 'rejected',
            decidedBy: SYSTEM_CLAIMS_ACTOR,
            decidedAt,
            reason,
          },
        },
        { session },
      )
      .exec();
    if (result.modifiedCount !== 1) return undefined;
    await this.record(
      SYSTEM_CLAIMS_ACTOR,
      'claim.rejected',
      claim,
      reason,
      session,
    );
    return decidedAt;
  }

  /**
   * Runs `work` in one transaction; the driver retries it on a transient
   * conflict, so `work` must start from the database each time.
   */
  private async inTransaction(work: (session: ClientSession) => Promise<void>) {
    const session = await this.claimModel.db.startSession();
    try {
      await session.withTransaction(() => work(session));
    } catch (error) {
      if (isTransactionUnsupported(error)) {
        this.logger.error(
          `Claims need a replica-set database: ${describeFailure(error)}`,
        );
        throw new ServiceUnavailableException(CLAIMS_NEED_REPLICA_SET);
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  private async record(
    actorUserId: string,
    action: string,
    claim: ClaimRow,
    reason: string,
    session?: ClientSession,
  ) {
    await this.log.record(
      {
        actorUserId,
        action,
        targetType: 'claim',
        targetId: String(claim._id),
        reason,
        details: { profileId: String(claim.profileId), userId: claim.userId },
      },
      session,
    );
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
