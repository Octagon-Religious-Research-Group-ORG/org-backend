import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ModerationLogService } from '../moderation/moderation-log.service';
import {
  ClerkOutcomeUnknown,
  ClerkUserInfoService,
} from './clerk-user-info.service';
import { settle, settledAs } from './write-outcome';
import type { MemberRole } from './roles';

export interface RoleChange {
  actorUserId: string;
  targetUserId: string;
  /** The new role; `null` removes any role. */
  role: MemberRole | null;
  reason: string;
  /**
   * Called first when the write's outcome becomes unknown, before anything
   * else can fail: the caller keeps its lock (review round 4).
   */
  onUnknown?: () => void;
}

export const MAX_REASON_LENGTH = 500;

/** Told to the admin when Clerk changed the role but the log entry failed. */
export const ROLE_AUDIT_INCOMPLETE_MESSAGE =
  'The role was changed, but the audit record is incomplete: it shows the change as requested, not applied.';

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
  private readonly logger = new Logger(RolesService.name);

  constructor(
    private readonly clerk: ClerkUserInfoService,
    private readonly log: ModerationLogService,
  ) {}

  /**
   * Every error it throws says what is known (`write-outcome.ts`): marked
   * `not-sent` before the request, `refused` when Clerk definitely refused,
   * `applied` when only the final audit entry failed. ANY other error is an
   * unknown outcome, thrown as a {@link ClerkOutcomeUnknown} (review round 5).
   */
  async setRole(change: RoleChange): Promise<void> {
    const { entry, details } = await this.beforeSending(change);
    try {
      await this.clerk.setRole(change.targetUserId, change.role);
    } catch (error) {
      if (settledAs(error) === 'refused') {
        await this.recordOrReport({
          ...entry,
          action: 'role.change.failed',
          details: {
            ...details,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }
      // Anything else: the role may have changed. The caller hears it first.
      try {
        change.onUnknown?.();
      } catch (hookError) {
        this.logger.error(
          `Could not mark a role change unknown: ${String(hookError)}`,
        );
      }
      // The request may still land: the log must not say "failed", and a
      // failing log write must not replace the outcome.
      await this.recordOrReport({
        ...entry,
        action: 'role.change.timeout',
        details: { ...details, outcome: 'unknown' },
      });
      throw error instanceof ClerkOutcomeUnknown
        ? error
        : new ClerkOutcomeUnknown();
    }
    try {
      await this.log.record({
        ...entry,
        action: 'role.change.applied',
        details,
      });
    } catch (error) {
      // Clerk has already changed the role, so a plain failure would be false.
      this.logger.error(
        `Role of ${change.targetUserId} changed to ${String(change.role)}, but the "applied" audit entry failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw settle(
        new InternalServerErrorException(ROLE_AUDIT_INCOMPLETE_MESSAGE),
        'applied',
      );
    }
  }

  /** Checks and the `requested` entry; any failure here sent nothing. */
  private async beforeSending(change: RoleChange) {
    try {
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
      return { entry, details };
    } catch (error) {
      throw settle(error, 'not-sent');
    }
  }

  private async recordOrReport(
    entry: Parameters<ModerationLogService['record']>[0],
  ) {
    try {
      await this.log.record(entry);
    } catch (error) {
      this.logger.error(
        `The "${entry.action}" audit entry for ${entry.targetId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
