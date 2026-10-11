import { BadRequestException, Injectable } from '@nestjs/common';
import { ModerationLogService } from '../moderation/moderation-log.service';
import { ClerkUserInfoService } from './clerk-user-info.service';
import type { MemberRole } from './roles';

export interface RoleChange {
  actorUserId: string;
  targetUserId: string;
  /** The new role; `null` removes any role. */
  role: MemberRole | null;
  reason: string;
}

export const MAX_REASON_LENGTH = 500;

/**
 * Changes member roles, leaving a permanent trail in the moderation log.
 *
 * Three entries per attempt, in order: `requested` before Clerk is touched,
 * then `applied` or `failed`. Writing the request first means a crash between
 * the Clerk call and the log can never leave a role change with no record.
 * Authorisation (is the actor an admin?) belongs to the caller.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly clerk: ClerkUserInfoService,
    private readonly log: ModerationLogService,
  ) {}

  async setRole(change: RoleChange): Promise<void> {
    const reason = change.reason.trim();
    if (!reason) {
      throw new BadRequestException('A role change needs a reason.');
    }
    if (reason.length > MAX_REASON_LENGTH) {
      throw new BadRequestException(
        `The reason can be at most ${MAX_REASON_LENGTH} characters.`,
      );
    }

    const current = await this.clerk.getIdentity(change.targetUserId);
    const entry = {
      actorUserId: change.actorUserId,
      targetType: 'user',
      targetId: change.targetUserId,
      reason,
    };
    const details = { from: current.role ?? null, to: change.role };

    await this.log.record({
      ...entry,
      action: 'role.change.requested',
      details,
    });
    try {
      await this.clerk.setRole(change.targetUserId, change.role);
    } catch (error) {
      await this.log.record({
        ...entry,
        action: 'role.change.failed',
        details: {
          ...details,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
    await this.log.record({ ...entry, action: 'role.change.applied', details });
  }
}
