import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import { AdminAccessService } from '../../auth/admin-access.service';
import {
  ClerkAdminDirectoryService,
  type PendingInvitation,
  type RoleHolder,
} from '../../auth/clerk-admin-directory.service';
import {
  ClerkOutcomeUnknown,
  ClerkUserInfoService,
} from '../../auth/clerk-user-info.service';
import { MAX_REASON_LENGTH, RolesService } from '../../auth/roles.service';
import { settle, settledAs } from '../../auth/write-outcome';
import { cleanMemberTitle } from '../../membership/member-text';
import { ModerationLogService } from '../../moderation/moderation-log.service';
import {
  ModerationLogEntry,
  type ModerationLogEntryDocument,
} from '../../moderation/schemas/moderation-log.schema';
import {
  SocialProfile,
  type SocialProfileDocument,
} from '../../social/schemas/social-profile.schema';
import {
  OrgSetting,
  type OrgSettingDocument,
} from '../schemas/org-setting.schema';

export const ROLE_LOCK_KEY = 'role-change-lock';

/**
 * After this long a role change starts no Clerk write (see the fence). Every
 * Clerk call is bounded by `CLERK_TIMEOUT_MS`, so a change also gives up
 * waiting soon after.
 */
export const ROLE_CHANGE_DEADLINE_MS = 90_000;
/**
 * A lock this old belongs to a change that died, or to one whose Clerk write
 * had an unknown outcome (that change never releases it). Far longer than a
 * change takes and than a Clerk request plausibly runs after we stop waiting.
 *
 * The window counts from the lock row's `updatedAt`. When an outcome becomes
 * unknown it is moved to that moment; if that one update fails (logged), the
 * window still counts from when the lock was taken, at most the change's own
 * duration earlier (bounded by {@link ROLE_CHANGE_DEADLINE_MS} plus one Clerk
 * timeout, about 100 s), so the lock then guards for at least ~200 s after
 * the unknown moment instead of 300 s. Accepted (review round 5): a takeover
 * is checked by other server instances, so an in-memory record would not
 * help, and a second write to the same row could fail the same way.
 */
export const ROLE_LOCK_STALE_MS = 300_000;
/** Admin invitations expire after this many days (Clerk's default is 30). */
export const ADMIN_INVITATION_DAYS = 3;
/** Clock difference allowed when matching a Clerk invitation to the log. */
export const INVITATION_MATCH_SLACK_MS = 60_000;

export const NOT_A_MEMBER = 'That account does not exist.';
export const ALREADY_ADMIN = 'That person is already an admin.';
export const NOT_ADMIN = 'That person is not an admin.';
export const OWN_DEMOTION =
  'You cannot remove your own admin role. Another admin must do it.';
export const OWN_PROMOTION = 'You cannot change your own role.';
export const NO_LONGER_ADMIN =
  'Your account is no longer an admin, so this change was not made.';
export const LAST_ADMIN =
  'This is the only admin. Make someone else an admin first.';
export const ALLOWLIST_ADMIN =
  "This person is an admin through the server's allowlist (WHITE_LISTED_EMAILS). Remove their address from the server configuration; the dashboard cannot.";
export const ADMINS_UNCOUNTABLE =
  'There are too many accounts to count the admins, so no admin can be removed from here. Please tell the site’s maintainer.';
export const ROLE_CHANGE_BUSY =
  'Another role change is under way. Please try again in a minute.';
export const ROLE_CHANGE_LOST =
  'This change took too long and was stopped before anything was changed. Please try again.';
export const OUTCOME_UNKNOWN =
  'The sign-in service did not confirm this change, so it may or may not have happened. Role changes are paused for up to 5 minutes; then check the list and the moderation log.';
export const DEMOTION_UNKNOWN =
  'The sign-in service did not confirm the removal, so the admin role may or may not have been removed. Role changes are paused for up to 5 minutes; then check the list, and if the role is gone, withdraw any invitations they sent.';
export const FOLLOW_UP_UNKNOWN =
  'The role was removed, but the sign-in service did not confirm whether one of their pending admin invitations was withdrawn. Role changes are paused for up to 5 minutes; then check the invitation list.';
export const FOLLOW_UP_WARNING =
  'The role was removed, but their pending admin invitations could not all be checked or withdrawn. Check the invitation list.';

/** An admin as the dashboard lists it. */
export interface AdminView extends RoleHolder {
  /** Their member page, when they have one. */
  page?: { slug: string; displayName: string };
  isYou: boolean;
  /**
   * Admin only through the server's switch-over allowlist, not a Clerk role:
   * removed from the server configuration, never from the dashboard.
   */
  viaAllowlist?: true;
  /** A Clerk admin whose address is also on the allowlist. */
  allowlisted?: true;
}

export type InviteAs = 'admin' | 'member';

/** The change no longer holds the lock, or its deadline has passed. */
class LockLost extends ServiceUnavailableException {
  constructor() {
    super(ROLE_CHANGE_LOST);
  }
}

/**
 * Whether a failed write is KNOWN not to have changed anything in Clerk (or
 * known to have been applied), so the lock may be released: marked by the
 * layer that knew (`write-outcome.ts`), or the fence stopped it before the
 * send. Everything else is an unknown outcome.
 */
function isKnownOutcome(error: unknown): boolean {
  return settledAs(error) !== undefined || error instanceof LockLost;
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * An address as the append-only log keeps it (review LOW-4): a SHA-256 of
 * the lowercase address and its domain. The readable address stays only in
 * Clerk's invitation, which can be withdrawn.
 */
export function emailForLog(email: string) {
  return {
    emailHash: createHash('sha256').update(email).digest('hex'),
    emailDomain: email.slice(email.lastIndexOf('@') + 1),
  };
}

/**
 * One role change's hold on the lock.
 * - `check` throws once the lock is lost or the deadline has passed;
 * - `unknown` records that a Clerk WRITE timed out: it may still land, and
 *   nothing can abort it, so this change keeps the lock until it goes stale.
 */
interface Change {
  check(): Promise<void>;
  unknown(): void;
}

/** A log row the after-demotion cleanup reads. */
interface InvitationRow {
  action: string;
  at: Date;
  details?: Record<string, unknown>;
}

/**
 * The Roles section of the admin dashboard (Chunk 12).
 *
 * - Every change (promote, demote, invite, withdraw) runs under one lock, and
 *   first asks Clerk, with no cache, whether the ACTOR is still an admin.
 * - Nobody changes their own role, and the last admin cannot be removed.
 * - Every Clerk call is bounded (`CLERK_TIMEOUT_MS`); right before each Clerk
 *   write the change checks it still holds the lock and its deadline. A write
 *   that times out is an UNKNOWN outcome, logged as such, and its change
 *   never releases the lock: it goes stale after {@link ROLE_LOCK_STALE_MS},
 *   so the write cannot run beside the next change (review round 3).
 * - A demotion clears the target's cached role and withdraws the admin
 *   invitations they sent, or may have sent, that are still waiting.
 * - The switch-over allowlist's admins are listed, but changed only in the
 *   server configuration; they never count towards "the last admin".
 * - There is deliberately no password tool (plan §2b item 1).
 */
@Injectable()
export class AdminRolesService {
  private readonly logger = new Logger(AdminRolesService.name);
  private readonly appUrl: string;

  constructor(
    config: ConfigService,
    private readonly directory: ClerkAdminDirectoryService,
    private readonly clerk: ClerkUserInfoService,
    private readonly roles: RolesService,
    private readonly log: ModerationLogService,
    @InjectModel(OrgSetting.name)
    private readonly settingModel: Model<OrgSettingDocument>,
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    private readonly adminAccess: AdminAccessService,
    @InjectModel(ModerationLogEntry.name)
    private readonly logModel: Model<ModerationLogEntryDocument>,
  ) {
    this.appUrl = config.getOrThrow<string>('PUBLIC_APP_URL');
  }

  async admins(adminId: string): Promise<{
    admins: AdminView[];
    complete: boolean;
    /** The allowlist could not be read; its admins may be missing. */
    allowlistUnknown?: true;
  }> {
    const { holders, complete } = await this.directory.holdersOf('admin');
    const clerkAdmins = new Set(holders.map((holder) => holder.userId));
    const allowlisted = new Set(this.adminAccess.allowlist());
    let onList: Array<{ holder: RoleHolder; role?: string }> = [];
    let allowlistUnknown = false;
    try {
      onList = (await this.directory.usersByEmail([...allowlisted])).filter(
        ({ holder, emailVerified }) =>
          emailVerified &&
          holder.email !== undefined &&
          allowlisted.has(holder.email),
      );
    } catch (error) {
      allowlistUnknown = true;
      this.logger.warn(
        `Could not read the allowlist's accounts: ${describe(error)}`,
      );
    }
    const listedIds = new Set(onList.map(({ holder }) => holder.userId));
    const everyone = [
      ...holders.map((holder) => ({ holder, viaAllowlist: false })),
      ...onList
        // A Clerk admin the list read missed is not "allowlist only".
        .filter(
          ({ holder, role }) =>
            !clerkAdmins.has(holder.userId) && role !== 'admin',
        )
        .map(({ holder }) => ({ holder, viaAllowlist: true })),
    ];
    const pages = await this.profileModel
      .find({
        ownerUserId: { $in: everyone.map(({ holder }) => holder.userId) },
        reviewStatus: { $ne: 'claiming' },
        deletedAt: { $exists: false },
      })
      .select({ ownerUserId: 1, slug: 1, displayName: 1 })
      .lean()
      .exec();
    const pageOf = new Map(pages.map((page) => [page.ownerUserId, page]));
    return {
      admins: everyone.map(({ holder, viaAllowlist }) => {
        const page = pageOf.get(holder.userId);
        return {
          ...holder,
          ...(page
            ? { page: { slug: page.slug, displayName: page.displayName } }
            : {}),
          isYou: holder.userId === adminId,
          ...(viaAllowlist ? { viaAllowlist: true as const } : {}),
          ...(!viaAllowlist && listedIds.has(holder.userId)
            ? { allowlisted: true as const }
            : {}),
        };
      }),
      complete,
      ...(allowlistUnknown ? { allowlistUnknown: true as const } : {}),
    };
  }

  /**
   * @throws ForbiddenException for yourself, or an actor no longer an admin
   * @throws NotFoundException for an unknown account
   * @throws ConflictException when they are already an admin, or another
   *   role change is running
   * @throws ServiceUnavailableException ({@link OUTCOME_UNKNOWN}) when the
   *   Clerk write timed out
   */
  async promote(adminId: string, userId: string, reason: string) {
    if (userId === adminId) throw new ForbiddenException(OWN_PROMOTION);
    return this.withRoleLock(adminId, async (change) => {
      await this.requireActorAdmin(adminId);
      const identity = await this.identityOf(userId);
      if (identity.role === 'admin') throw new ConflictException(ALREADY_ADMIN);
      await change.check();
      try {
        await this.roles.setRole({
          actorUserId: adminId,
          targetUserId: userId,
          role: 'admin',
          reason,
          onUnknown: () => change.unknown(),
        });
      } catch (error) {
        // Only a write known not to have happened is a plain failure.
        if (isKnownOutcome(error)) throw error;
        change.unknown();
        throw new ServiceUnavailableException(OUTCOME_UNKNOWN);
      }
      return { role: 'admin' as const };
    });
  }

  /**
   * @returns the new role, and a warning when a follow-up (clearing the
   *   cached role, withdrawing their invitations) did not fully happen
   * @throws ForbiddenException for yourself, or an actor no longer an admin
   * @throws ConflictException for the last admin, someone not an admin, an
   *   allowlist admin, or another role change running
   * @throws ServiceUnavailableException when the admins cannot all be
   *   counted, or ({@link DEMOTION_UNKNOWN}) when the Clerk write timed out
   */
  async demote(adminId: string, userId: string, reason: string) {
    if (userId === adminId) throw new ForbiddenException(OWN_DEMOTION);
    return this.withRoleLock(adminId, async (change) => {
      await this.requireActorAdmin(adminId);
      const identity = await this.identityOf(userId);
      if (
        this.adminAccess.isAllowlisted(identity.email, identity.emailVerified)
      ) {
        throw new ConflictException(ALLOWLIST_ADMIN);
      }
      if (identity.role !== 'admin') throw new ConflictException(NOT_ADMIN);
      const { holders, complete } = await this.directory.holdersOf('admin');
      if (!complete) throw new ServiceUnavailableException(ADMINS_UNCOUNTABLE);
      // Clerk roles only: an allowlist admin may vanish with a config change.
      const others = holders.filter((holder) => holder.userId !== userId);
      if (others.length === 0) throw new ConflictException(LAST_ADMIN);
      await change.check();
      try {
        await this.roles.setRole({
          actorUserId: adminId,
          targetUserId: userId,
          role: null,
          reason,
          onUnknown: () => change.unknown(),
        });
      } catch (error) {
        if (isKnownOutcome(error)) throw error;
        change.unknown();
        // Harmless either way: it only makes the next check ask Clerk.
        await this.forgetRole(userId);
        throw new ServiceUnavailableException(DEMOTION_UNKNOWN);
      }
      const done = await this.afterDemotion(change, adminId, userId);
      return {
        role: null,
        ...(done === 'done'
          ? {}
          : {
              followUpWarning:
                done === 'unknown' ? FOLLOW_UP_UNKNOWN : FOLLOW_UP_WARNING,
            }),
      };
    });
  }

  invitations(): Promise<{
    invitations: PendingInvitation[];
    complete: boolean;
  }> {
    return this.directory.pendingInvitations();
  }

  /**
   * Invites someone by email, as an admin (expiring after
   * {@link ADMIN_INVITATION_DAYS} days) or as a member. Each attempt carries
   * an `attemptId` through its log entries, so a later cleanup can tell which
   * requests ended and which have an unknown outcome.
   *
   * @throws ForbiddenException for an actor no longer an admin
   * @throws ConflictException / BadRequestException from Clerk, after the
   *   `failed` entry is written
   * @throws ServiceUnavailableException ({@link OUTCOME_UNKNOWN}) after an
   *   `unknown` entry: the invitation may exist
   */
  async invite(
    adminId: string,
    rawEmail: string,
    as: InviteAs,
    rawReason: string | undefined,
  ): Promise<PendingInvitation> {
    const email = rawEmail.trim().toLowerCase();
    const reason =
      cleanMemberTitle(rawReason ?? '').slice(0, MAX_REASON_LENGTH) ||
      (as === 'admin'
        ? 'Admin invited a new admin.'
        : 'Admin invited a new member.');
    const hidden = emailForLog(email);
    const attemptId = randomUUID();
    const entry = {
      actorUserId: adminId,
      targetType: 'invitation',
      targetId: `email-sha256:${hidden.emailHash.slice(0, 32)}`,
      reason,
    };
    return this.withRoleLock(adminId, async (change) => {
      await this.requireActorAdmin(adminId);
      await this.log.record({
        ...entry,
        action: 'invitation.requested',
        details: { as, ...hidden, attemptId },
      });
      let invitation: PendingInvitation;
      try {
        await change.check();
        invitation = await this.directory.invite(
          email,
          as === 'admin' ? 'admin' : null,
          `${this.appUrl.replace(/\/+$/, '')}/community`,
          as === 'admin' ? ADMIN_INVITATION_DAYS : undefined,
        );
      } catch (error) {
        // Known only when refused or never sent; anything else (our own
        // code after the send included) is unknown. Marked before anything
        // else can fail.
        const unknown = !(
          settledAs(error) === 'refused' || error instanceof LockLost
        );
        if (unknown) change.unknown();
        await this.recordOrReport({
          ...entry,
          action: unknown ? 'invitation.unknown' : 'invitation.failed',
          details: { as, ...hidden, attemptId, error: describe(error) },
        });
        if (unknown) throw new ServiceUnavailableException(OUTCOME_UNKNOWN);
        throw error;
      }
      await this.log.record({
        ...entry,
        action: 'invitation.sent',
        details: {
          as,
          ...hidden,
          attemptId,
          invitationId: invitation.invitationId,
          invitedBy: adminId,
          ...(as === 'admin' ? { expiresInDays: ADMIN_INVITATION_DAYS } : {}),
        },
      });
      return invitation;
    });
  }

  /**
   * @throws ForbiddenException for an actor no longer an admin
   * @throws NotFoundException when it is unknown or no longer waiting
   * @throws ServiceUnavailableException ({@link OUTCOME_UNKNOWN}) when Clerk
   *   did not answer in time
   */
  async revokeInvitation(adminId: string, invitationId: string) {
    return this.withRoleLock(adminId, async (change) => {
      await this.requireActorAdmin(adminId);
      await change.check();
      try {
        await this.revokeLogged(
          change,
          adminId,
          invitationId,
          'Admin withdrew an invitation.',
        );
      } catch (error) {
        if (error instanceof ClerkOutcomeUnknown) {
          throw new ServiceUnavailableException(OUTCOME_UNKNOWN);
        }
        throw error;
      }
      return { revoked: true };
    });
  }

  /**
   * After a demotion: no cached role of theirs survives, and the admin
   * invitations they sent, or may have sent, stop working. Neither undoes the
   * demotion, so a failure is logged and reported as a warning rather than
   * thrown. Before each withdrawal it checks the deadline and the fence, and
   * stops at the first that fails.
   *
   * @returns `done`; `warn` when something could not be done or checked;
   *   `unknown` when a withdrawal had an unknown outcome (lock kept)
   */
  private async afterDemotion(
    change: Change,
    adminId: string,
    userId: string,
  ): Promise<'done' | 'warn' | 'unknown'> {
    let done = await this.forgetRole(userId);
    let unknown = false;
    const result = () => (unknown ? 'unknown' : done ? 'done' : 'warn');
    try {
      const rows = (await this.logModel
        .find({
          actorUserId: userId,
          action: {
            $in: [
              'invitation.sent',
              'invitation.requested',
              'invitation.unknown',
              'invitation.failed',
            ],
          },
          'details.as': 'admin',
        })
        .select({ action: 1, at: 1, details: 1 })
        .lean()
        .exec()) as unknown as InvitationRow[];
      if (rows.length === 0) return result();
      const { sentIds, openWindows } = invitationLeads(rows);
      const { invitations, complete } =
        await this.directory.pendingInvitations();
      if (!complete) done = false;
      for (const invitation of invitations) {
        if (!isTheirs(invitation, sentIds, openWindows)) continue;
        try {
          await change.check();
          await this.revokeLogged(
            change,
            adminId,
            invitation.invitationId,
            'The admin who sent this invitation is no longer an admin.',
          );
        } catch (error) {
          done = false;
          // Refused: try the next. Not sent (lock, deadline, log): stop.
          // Anything else is an unknown outcome: stop, the lock is kept.
          if (settledAs(error) === 'refused') continue;
          if (!(error instanceof LockLost || settledAs(error) === 'not-sent')) {
            unknown = true;
          }
          break;
        }
      }
    } catch (error) {
      done = false;
      this.logger.error(
        `Could not withdraw the invitations ${userId} sent: ${describe(error)}`,
      );
    }
    return result();
  }

  /** @returns false when the cached role could not be cleared (logged) */
  private async forgetRole(userId: string): Promise<boolean> {
    try {
      await this.adminAccess.forgetRole(userId);
      return true;
    } catch (error) {
      this.logger.error(
        `Could not clear the cached role of ${userId}: ${describe(error)}`,
      );
      return false;
    }
  }

  private async revokeLogged(
    change: Change,
    adminId: string,
    invitationId: string,
    reason: string,
  ) {
    const entry = {
      actorUserId: adminId,
      targetType: 'invitation',
      targetId: invitationId,
      reason,
    };
    try {
      await this.log.record({
        ...entry,
        action: 'invitation.revoke.requested',
      });
    } catch (error) {
      throw settle(error, 'not-sent');
    }
    try {
      await this.directory.revoke(invitationId);
    } catch (error) {
      // Known only when Clerk refused; anything else is unknown, marked
      // before anything else can fail.
      const unknown = settledAs(error) !== 'refused';
      if (unknown) change.unknown();
      await this.recordOrReport({
        ...entry,
        action: unknown
          ? 'invitation.revoke.unknown'
          : 'invitation.revoke.failed',
        details: { error: describe(error) },
      });
      if (unknown && !(error instanceof ClerkOutcomeUnknown)) {
        throw new ClerkOutcomeUnknown();
      }
      throw error;
    }
    await this.log.record({ ...entry, action: 'invitation.revoke.applied' });
  }

  /** An audit entry that must never replace the outcome being recorded. */
  private async recordOrReport(
    entry: Parameters<ModerationLogService['record']>[0],
  ) {
    try {
      await this.log.record(entry);
    } catch (error) {
      this.logger.error(
        `The "${entry.action}" audit entry for ${entry.targetId} failed: ${describe(error)}`,
      );
    }
  }

  /**
   * The actor's role, asked of Clerk now with no cache.
   *
   * @throws ForbiddenException when they are no longer an admin
   */
  private async requireActorAdmin(adminId: string) {
    let isAdmin: boolean;
    try {
      isAdmin = await this.adminAccess.isAdminNow(adminId);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 401) {
        throw new ForbiddenException(NO_LONGER_ADMIN);
      }
      throw error;
    }
    if (!isAdmin) throw new ForbiddenException(NO_LONGER_ADMIN);
  }

  /** Clerk's "no such user" (401 from the identity lookup) is a 404 here. */
  private async identityOf(userId: string) {
    try {
      return await this.clerk.getIdentity(userId);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 401) {
        throw new NotFoundException(NOT_A_MEMBER);
      }
      throw error;
    }
  }

  /**
   * One role change at a time, across every server instance: the lock is a
   * row with a unique key, taken over only once it is stale. The change gets
   * a fence (its token and deadline, checked before each Clerk write). It
   * releases the lock when it ends, unless one of its writes had an unknown
   * outcome: then the lock is left to go stale.
   */
  private async withRoleLock<T>(
    adminId: string,
    work: (change: Change) => Promise<T>,
  ): Promise<T> {
    const token = randomUUID();
    const deadline = Date.now() + ROLE_CHANGE_DEADLINE_MS;
    try {
      await this.settingModel
        .updateOne(
          {
            key: ROLE_LOCK_KEY,
            updatedAt: { $lt: new Date(Date.now() - ROLE_LOCK_STALE_MS) },
          },
          { $set: { value: token, updatedBy: adminId } },
          { upsert: true },
        )
        .exec();
    } catch (error) {
      if (isDuplicateKey(error)) throw new ConflictException(ROLE_CHANGE_BUSY);
      throw error;
    }
    let outcomeUnknown = false;
    let bump: Promise<void> = Promise.resolve();
    const change: Change = {
      check: async () => {
        const held =
          Date.now() < deadline &&
          (await this.settingModel
            .exists({ key: ROLE_LOCK_KEY, value: token })
            .exec()) !== null;
        if (!held) throw new LockLost();
      },
      unknown: () => {
        if (outcomeUnknown) return;
        outcomeUnknown = true;
        // The stale window starts now, when the outcome became unknown. The
        // flag above is what keeps the lock; nothing here may throw past it.
        const failedBump = (error: unknown) => {
          this.logger.error(
            `Could not restart the role lock's stale window: ${describe(error)}`,
          );
        };
        try {
          bump = this.settingModel
            .updateOne(
              { key: ROLE_LOCK_KEY, value: token },
              { $set: { updatedAt: new Date() } },
              { timestamps: false },
            )
            .exec()
            .then(() => undefined, failedBump);
        } catch (error) {
          failedBump(error);
        }
      },
    };
    try {
      return await work(change);
    } finally {
      if (outcomeUnknown) {
        await bump;
        this.logger.warn(
          'A Clerk write timed out: the role lock is kept until it goes stale.',
        );
      } else {
        try {
          await this.settingModel
            .deleteOne({ key: ROLE_LOCK_KEY, value: token })
            .exec();
        } catch (error) {
          // Never in place of the change's own result or error; the lock
          // then goes stale and is taken over.
          this.logger.error(
            `Could not release the role lock: ${describe(error)}`,
          );
        }
      }
    }
  }
}

/**
 * From a demoted admin's own invitation log entries: the ids of the
 * invitations Clerk confirmed, and the time windows of attempts with no
 * known outcome (an `unknown` entry, or a `requested` one with neither
 * `sent` nor `failed` for the same attempt). Only those windows may match a
 * waiting invitation by address, so another admin's later invitation to the
 * same address is never theirs (review round 3, LOW-1).
 */
export function invitationLeads(rows: InvitationRow[]) {
  const sentIds = new Set<string>();
  const ended = new Set<string>();
  for (const row of rows) {
    const attemptId = row.details?.attemptId;
    if (row.action === 'invitation.sent') {
      sentIds.add(String(row.details?.invitationId));
    }
    if (
      (row.action === 'invitation.sent' ||
        row.action === 'invitation.failed') &&
      typeof attemptId === 'string'
    ) {
      ended.add(attemptId);
    }
  }
  const openWindows: Array<{ hash: string; from: number; to: number }> = [];
  for (const row of rows) {
    const at = new Date(row.at).getTime();
    const hash = String(row.details?.emailHash);
    const attemptId = row.details?.attemptId;
    if (row.action === 'invitation.unknown') {
      openWindows.push({
        hash,
        from: at - ROLE_CHANGE_DEADLINE_MS - INVITATION_MATCH_SLACK_MS,
        to: at + INVITATION_MATCH_SLACK_MS,
      });
    } else if (
      row.action === 'invitation.requested' &&
      !(typeof attemptId === 'string' && ended.has(attemptId))
    ) {
      openWindows.push({
        hash,
        from: at - INVITATION_MATCH_SLACK_MS,
        to: at + ROLE_CHANGE_DEADLINE_MS + INVITATION_MATCH_SLACK_MS,
      });
    }
  }
  return { sentIds, openWindows };
}

/** Whether a waiting invitation is one the demoted admin sent or may have. */
export function isTheirs(
  invitation: PendingInvitation,
  sentIds: Set<string>,
  openWindows: Array<{ hash: string; from: number; to: number }>,
): boolean {
  if (sentIds.has(invitation.invitationId)) return true;
  if (invitation.role !== 'admin') return false;
  const hash = emailForLog(invitation.email).emailHash;
  // No creation time: it can match only by id.
  const created = invitation.createdAt
    ? new Date(invitation.createdAt).getTime()
    : Number.NaN;
  return openWindows.some(
    (window) =>
      window.hash === hash && created >= window.from && created <= window.to,
  );
}
