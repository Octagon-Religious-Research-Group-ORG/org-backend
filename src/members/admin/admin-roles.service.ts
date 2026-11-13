import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import {
  ClerkAdminDirectoryService,
  type PendingInvitation,
} from '../../auth/clerk-admin-directory.service';
import { ClerkUserInfoService } from '../../auth/clerk-user-info.service';
import { MAX_REASON_LENGTH, RolesService } from '../../auth/roles.service';
import { cleanMemberTitle } from '../../membership/member-text';
import { ModerationLogService } from '../../moderation/moderation-log.service';
import {
  SocialProfile,
  type SocialProfileDocument,
} from '../../social/schemas/social-profile.schema';
import {
  OrgSetting,
  type OrgSettingDocument,
} from '../schemas/org-setting.schema';

export const ROLE_LOCK_KEY = 'role-change-lock';
/** A lock this old belongs to a role change that died; it is taken over. */
export const ROLE_LOCK_STALE_MS = 60_000;

export const NOT_A_MEMBER = 'That account does not exist.';
export const ALREADY_ADMIN = 'That person is already an admin.';
export const NOT_ADMIN = 'That person is not an admin.';
export const OWN_DEMOTION =
  'You cannot remove your own admin role. Another admin must do it.';
export const LAST_ADMIN =
  'This is the only admin. Make someone else an admin first.';
export const ADMINS_UNCOUNTABLE =
  'There are too many accounts to count the admins, so no admin can be removed from here. Please tell the site’s maintainer.';
export const ROLE_CHANGE_BUSY =
  'Another role change is under way. Please try again in a minute.';

/** An admin as the dashboard lists them. */
export interface AdminView {
  userId: string;
  email?: string;
  name?: string;
  /** Their member page, when they have one. */
  page?: { slug: string; displayName: string };
  isYou: boolean;
}

export type InviteAs = 'admin' | 'member';

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * The Roles section of the admin dashboard (Chunk 12).
 *
 * - Promote and demote go through `RolesService`, which logs `requested`
 *   before Clerk is touched and then `applied` or `failed`.
 * - Nobody removes their own admin role, and the last admin cannot be
 *   removed. Role changes run one at a time (a lock in `orgsettings`), so two
 *   admins cannot remove each other at the same moment and leave none. Only
 *   the Clerk role counts here; the old `WHITE_LISTED_EMAILS` switch-over list
 *   is not an admin anyone can manage.
 * - Invitations are Clerk's: Clerk emails the person, and an admin invitation
 *   carries the role into their account when they accept. Logged the same
 *   way: requested, then sent or failed.
 * - There is deliberately no password tool (plan §2b item 1): resets are by
 *   email, by the member.
 */
@Injectable()
export class AdminRolesService {
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
  ) {
    this.appUrl = config.getOrThrow<string>('PUBLIC_APP_URL');
  }

  async admins(
    adminId: string,
  ): Promise<{ admins: AdminView[]; complete: boolean }> {
    const { holders, complete } = await this.directory.holdersOf('admin');
    const pages = await this.profileModel
      .find({
        ownerUserId: { $in: holders.map((holder) => holder.userId) },
        reviewStatus: { $ne: 'claiming' },
        deletedAt: { $exists: false },
      })
      .select({ ownerUserId: 1, slug: 1, displayName: 1 })
      .lean()
      .exec();
    const pageOf = new Map(pages.map((page) => [page.ownerUserId, page]));
    return {
      admins: holders.map((holder) => {
        const page = pageOf.get(holder.userId);
        return {
          ...holder,
          ...(page
            ? { page: { slug: page.slug, displayName: page.displayName } }
            : {}),
          isYou: holder.userId === adminId,
        };
      }),
      complete,
    };
  }

  /**
   * @throws NotFoundException for an unknown account
   * @throws ConflictException when they are already an admin, or another
   *   role change is running
   */
  async promote(adminId: string, userId: string, reason: string) {
    return this.withRoleLock(adminId, async () => {
      const identity = await this.identityOf(userId);
      if (identity.role === 'admin') throw new ConflictException(ALREADY_ADMIN);
      await this.roles.setRole({
        actorUserId: adminId,
        targetUserId: userId,
        role: 'admin',
        reason,
      });
      return { role: 'admin' as const };
    });
  }

  /**
   * @throws ForbiddenException for yourself
   * @throws ConflictException for the last admin, someone not an admin, or
   *   another role change running
   * @throws ServiceUnavailableException when the admins cannot all be counted
   */
  async demote(adminId: string, userId: string, reason: string) {
    if (userId === adminId) throw new ForbiddenException(OWN_DEMOTION);
    return this.withRoleLock(adminId, async () => {
      const identity = await this.identityOf(userId);
      if (identity.role !== 'admin') throw new ConflictException(NOT_ADMIN);
      const { holders, complete } = await this.directory.holdersOf('admin');
      if (!complete) throw new ServiceUnavailableException(ADMINS_UNCOUNTABLE);
      const others = holders.filter((holder) => holder.userId !== userId);
      if (others.length === 0) throw new ConflictException(LAST_ADMIN);
      await this.roles.setRole({
        actorUserId: adminId,
        targetUserId: userId,
        role: null,
        reason,
      });
      return { role: null };
    });
  }

  invitations(): Promise<PendingInvitation[]> {
    return this.directory.pendingInvitations();
  }

  /**
   * Invites someone by email, as an admin or as a member.
   *
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
    const entry = {
      actorUserId: adminId,
      targetType: 'invitation',
      targetId: email,
      reason,
    };
    await this.log.record({
      ...entry,
      action: 'invitation.requested',
      details: { as },
    });
    let invitation: PendingInvitation;
    try {
      invitation = await this.directory.invite(
        email,
        as === 'admin' ? 'admin' : null,
        `${this.appUrl.replace(/\/+$/, '')}/community`,
      );
    } catch (error) {
      await this.log.record({
        ...entry,
        action: 'invitation.failed',
        details: {
          as,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
    await this.log.record({
      ...entry,
      action: 'invitation.sent',
      details: { as, invitationId: invitation.invitationId },
    });
    return invitation;
  }

  /** @throws NotFoundException when it is unknown or no longer waiting */
  async revokeInvitation(adminId: string, invitationId: string) {
    const entry = {
      actorUserId: adminId,
      targetType: 'invitation',
      targetId: invitationId,
      reason: 'Admin withdrew an invitation.',
    };
    await this.log.record({ ...entry, action: 'invitation.revoke.requested' });
    try {
      await this.directory.revoke(invitationId);
    } catch (error) {
      await this.log.record({
        ...entry,
        action: 'invitation.revoke.failed',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
    await this.log.record({ ...entry, action: 'invitation.revoke.applied' });
    return { revoked: true };
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
   * row with a unique key, taken over only once it is old enough to belong
   * to a change that died.
   */
  private async withRoleLock<T>(
    adminId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const token = randomUUID();
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
    try {
      return await work();
    } finally {
      await this.settingModel
        .deleteOne({ key: ROLE_LOCK_KEY, value: token })
        .exec();
    }
  }
}
