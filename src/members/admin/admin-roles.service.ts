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
import { ClerkUserInfoService } from '../../auth/clerk-user-info.service';
import { MAX_REASON_LENGTH, RolesService } from '../../auth/roles.service';
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

/** Longest wait for one Clerk call during a role change. */
export const CLERK_CALL_TIMEOUT_MS = 10_000;
/** Longest wait for a list read page by page (every user, every invitation). */
export const CLERK_LIST_TIMEOUT_MS = 30_000;
/** Longest wait for RolesService's own read, log and write together. */
export const ROLE_WRITE_TIMEOUT_MS = 15_000;
/**
 * A role change gives up after this long, whatever it is waiting for, and
 * after it no Clerk write of that change can start (see the fence).
 */
export const ROLE_CHANGE_DEADLINE_MS = 90_000;
/**
 * A lock this old belongs to a change that died, and is taken over. Far
 * longer than {@link ROLE_CHANGE_DEADLINE_MS}, so a live change has always
 * given up before anyone can take its lock (review MEDIUM-1).
 */
export const ROLE_LOCK_STALE_MS = 300_000;
/** Admin invitations expire after this many days (Clerk's default is 30). */
export const ADMIN_INVITATION_DAYS = 3;

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
export const CLERK_TOO_SLOW =
  'The sign-in service took too long to answer. Please try again; check the moderation log first.';

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
}

export type InviteAs = 'admin' | 'member';

class TimedOut extends Error {}

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

/** `work`, or a {@link TimedOut} after `ms`; the timer never outlives it. */
export async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimedOut()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

/** A role change's hold on the lock; `check` throws once it is lost. */
interface Fence {
  check(): Promise<void>;
}

/**
 * The Roles section of the admin dashboard (Chunk 12).
 *
 * - Every change (promote, demote, invite, withdraw) runs under one lock, and
 *   first asks Clerk, with no cache, whether the ACTOR is still an admin: a
 *   demoted admin's cached role must not let them act (review HIGH-1).
 * - Nobody changes their own role, and the last admin cannot be removed.
 * - Clerk calls have timeouts and the whole change a deadline far inside the
 *   lock's stale window; right before each Clerk write the change checks it
 *   still holds the lock (a fencing token), so a lock taken over can never
 *   let two changes write (review MEDIUM-1).
 * - A demotion clears the target's cached role and withdraws the admin
 *   invitations they sent that are still waiting (review MEDIUM-3).
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

  async admins(
    adminId: string,
  ): Promise<{ admins: AdminView[]; complete: boolean }> {
    const { holders, complete } = await this.directory.holdersOf('admin');
    const clerkAdmins = new Set(holders.map((holder) => holder.userId));
    const allowlisted = new Set(this.adminAccess.allowlist());
    const allowlistOnly = (
      await this.directory.usersByEmail([...allowlisted])
    ).filter(
      ({ holder, role, emailVerified }) =>
        emailVerified &&
        role !== 'admin' &&
        holder.email !== undefined &&
        allowlisted.has(holder.email) &&
        !clerkAdmins.has(holder.userId),
    );
    const everyone = [
      ...holders.map((holder) => ({ holder, viaAllowlist: false })),
      ...allowlistOnly.map(({ holder }) => ({ holder, viaAllowlist: true })),
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
        };
      }),
      complete,
    };
  }

  /**
   * @throws ForbiddenException for yourself, or an actor no longer an admin
   * @throws NotFoundException for an unknown account
   * @throws ConflictException when they are already an admin, or another
   *   role change is running
   */
  async promote(adminId: string, userId: string, reason: string) {
    if (userId === adminId) throw new ForbiddenException(OWN_PROMOTION);
    return this.withRoleLock(adminId, async (fence) => {
      await this.requireActorAdmin(adminId);
      const identity = await this.identityOf(userId);
      if (identity.role === 'admin') throw new ConflictException(ALREADY_ADMIN);
      await fence.check();
      await this.setRole(adminId, userId, 'admin', reason);
      return { role: 'admin' as const };
    });
  }

  /**
   * @throws ForbiddenException for yourself, or an actor no longer an admin
   * @throws ConflictException for the last admin, someone not an admin, an
   *   allowlist admin, or another role change running
   * @throws ServiceUnavailableException when the admins cannot all be counted
   */
  async demote(adminId: string, userId: string, reason: string) {
    if (userId === adminId) throw new ForbiddenException(OWN_DEMOTION);
    return this.withRoleLock(adminId, async (fence) => {
      await this.requireActorAdmin(adminId);
      const identity = await this.identityOf(userId);
      if (
        this.adminAccess.isAllowlisted(identity.email, identity.emailVerified)
      ) {
        throw new ConflictException(ALLOWLIST_ADMIN);
      }
      if (identity.role !== 'admin') throw new ConflictException(NOT_ADMIN);
      const { holders, complete } = await this.clerkCall(
        this.directory.holdersOf('admin'),
        CLERK_LIST_TIMEOUT_MS,
      );
      if (!complete) throw new ServiceUnavailableException(ADMINS_UNCOUNTABLE);
      // Clerk roles only: an allowlist admin may vanish with a config change.
      const others = holders.filter((holder) => holder.userId !== userId);
      if (others.length === 0) throw new ConflictException(LAST_ADMIN);
      await fence.check();
      await this.setRole(adminId, userId, null, reason);
      await this.afterDemotion(adminId, userId);
      return { role: null };
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
   * {@link ADMIN_INVITATION_DAYS} days) or as a member.
   *
   * @throws ForbiddenException for an actor no longer an admin
   * @throws ConflictException / BadRequestException from Clerk, after the
   *   `failed` entry is written
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
    const entry = {
      actorUserId: adminId,
      targetType: 'invitation',
      targetId: `email-sha256:${hidden.emailHash.slice(0, 32)}`,
      reason,
    };
    return this.withRoleLock(adminId, async (fence) => {
      await this.requireActorAdmin(adminId);
      await this.log.record({
        ...entry,
        action: 'invitation.requested',
        details: { as, ...hidden },
      });
      let invitation: PendingInvitation;
      try {
        await fence.check();
        invitation = await this.clerkCall(
          this.directory.invite(
            email,
            as === 'admin' ? 'admin' : null,
            `${this.appUrl.replace(/\/+$/, '')}/community`,
            as === 'admin' ? ADMIN_INVITATION_DAYS : undefined,
          ),
          CLERK_CALL_TIMEOUT_MS,
        );
      } catch (error) {
        await this.log.record({
          ...entry,
          action: 'invitation.failed',
          details: { as, ...hidden, error: describe(error) },
        });
        throw error;
      }
      await this.log.record({
        ...entry,
        action: 'invitation.sent',
        details: {
          as,
          ...hidden,
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
   */
  async revokeInvitation(adminId: string, invitationId: string) {
    return this.withRoleLock(adminId, async (fence) => {
      await this.requireActorAdmin(adminId);
      await this.revokeLogged(
        adminId,
        invitationId,
        'Admin withdrew an invitation.',
        fence,
      );
      return { revoked: true };
    });
  }

  /**
   * After a demotion: no cached role of theirs survives here, and the admin
   * invitations they sent stop working. Neither undoes the demotion, so a
   * failure is logged rather than thrown.
   */
  private async afterDemotion(adminId: string, userId: string) {
    try {
      await this.adminAccess.forgetRole(userId);
    } catch (error) {
      this.logger.error(
        `Could not clear the cached role of ${userId}: ${describe(error)}`,
      );
    }
    try {
      const sent = await this.logModel
        .find({
          action: 'invitation.sent',
          actorUserId: userId,
          'details.as': 'admin',
        })
        .select({ details: 1 })
        .lean()
        .exec();
      const theirs = new Set(
        sent.map((row) => String(row.details?.invitationId)),
      );
      if (theirs.size === 0) return;
      const { invitations } = await this.clerkCall(
        this.directory.pendingInvitations(),
        CLERK_LIST_TIMEOUT_MS,
      );
      for (const invitation of invitations) {
        if (!theirs.has(invitation.invitationId)) continue;
        await this.revokeLogged(
          adminId,
          invitation.invitationId,
          'The admin who sent this invitation is no longer an admin.',
        ).catch(() => undefined);
      }
    } catch (error) {
      this.logger.error(
        `Could not withdraw the invitations ${userId} sent: ${describe(error)}`,
      );
    }
  }

  private async revokeLogged(
    adminId: string,
    invitationId: string,
    reason: string,
    fence?: Fence,
  ) {
    const entry = {
      actorUserId: adminId,
      targetType: 'invitation',
      targetId: invitationId,
      reason,
    };
    await this.log.record({ ...entry, action: 'invitation.revoke.requested' });
    try {
      await fence?.check();
      await this.clerkCall(
        this.directory.revoke(invitationId),
        CLERK_CALL_TIMEOUT_MS,
      );
    } catch (error) {
      await this.log.record({
        ...entry,
        action: 'invitation.revoke.failed',
        details: { error: describe(error) },
      });
      throw error;
    }
    await this.log.record({ ...entry, action: 'invitation.revoke.applied' });
  }

  /**
   * The actor's role, asked of Clerk now with no cache.
   *
   * @throws ForbiddenException when they are no longer an admin
   */
  private async requireActorAdmin(adminId: string) {
    let isAdmin: boolean;
    try {
      isAdmin = await this.clerkCall(
        this.adminAccess.isAdminNow(adminId),
        CLERK_CALL_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 401) {
        throw new ForbiddenException(NO_LONGER_ADMIN);
      }
      throw error;
    }
    if (!isAdmin) throw new ForbiddenException(NO_LONGER_ADMIN);
  }

  /**
   * RolesService writes `requested` before Clerk, then `applied`/`failed`.
   * When Clerk does not answer in time, a `timeout` entry says the outcome is
   * unknown, so the log never claims a result it does not have.
   */
  private async setRole(
    adminId: string,
    userId: string,
    role: 'admin' | null,
    reason: string,
  ) {
    try {
      await within(
        this.roles.setRole({
          actorUserId: adminId,
          targetUserId: userId,
          role,
          reason,
        }),
        ROLE_WRITE_TIMEOUT_MS,
      );
    } catch (error) {
      if (!(error instanceof TimedOut)) throw error;
      await this.log.record({
        actorUserId: adminId,
        action: 'role.change.timeout',
        targetType: 'user',
        targetId: userId,
        reason: 'Clerk did not answer in time; the outcome is unknown.',
        details: { to: role },
      });
      throw new ServiceUnavailableException(CLERK_TOO_SLOW);
    }
  }

  /** A Clerk call with a timeout, in words an admin can act on. */
  private async clerkCall<T>(work: Promise<T>, ms: number): Promise<T> {
    try {
      return await within(work, ms);
    } catch (error) {
      if (error instanceof TimedOut) {
        throw new ServiceUnavailableException(CLERK_TOO_SLOW);
      }
      throw error;
    }
  }

  /** Clerk's "no such user" (401 from the identity lookup) is a 404 here. */
  private async identityOf(userId: string) {
    try {
      return await this.clerkCall(
        this.clerk.getIdentity(userId),
        CLERK_CALL_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 401) {
        throw new NotFoundException(NOT_A_MEMBER);
      }
      throw error;
    }
  }

  /**
   * One role change at a time, across every server instance: the lock is a
   * row with a unique key, taken over only once it is older than any live
   * change can be. The change gets a fence: right before each Clerk write it
   * checks the row still carries its token and its deadline has not passed.
   */
  private async withRoleLock<T>(
    adminId: string,
    work: (fence: Fence) => Promise<T>,
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
    const fence: Fence = {
      check: async () => {
        const held =
          Date.now() < deadline &&
          (await this.settingModel
            .exists({ key: ROLE_LOCK_KEY, value: token })
            .exec()) !== null;
        if (!held) throw new ServiceUnavailableException(ROLE_CHANGE_LOST);
      },
    };
    try {
      return await work(fence);
    } finally {
      try {
        await this.settingModel
          .deleteOne({ key: ROLE_LOCK_KEY, value: token })
          .exec();
      } catch (error) {
        // Never in place of the change's own result or error; the lock then
        // goes stale and is taken over.
        this.logger.error(
          `Could not release the role lock: ${describe(error)}`,
        );
      }
    }
  }
}
