import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Response } from 'express';
import { getUserSub } from '../auth/auth.helpers';
import type { AuthenticatedRequest } from '../auth/auth.types';
import {
  SLUG_CHECK_ACCOUNT_THROTTLE,
  SLUG_CHECK_DAILY_LIMIT_CODE,
} from '../config/throttle';

/**
 * The address check's daily ration per account: at most `limit` checks in any
 * 24 hours. It runs after the login check, because the global ThrottlerGuard
 * runs before it and can only see an IP.
 *
 * It keeps its own timestamps instead of the throttler's storage. That storage
 * (`@nestjs/throttler` 6.5.0) cancels the decrement timers of EVERY key when
 * any one key's block ends, so counts stop falling and an account could be
 * locked out falsely after long uptime. Timestamps have no timers to cancel.
 *
 * Held in memory like the other limits, so it starts again when the server
 * restarts and is per instance; the ration slows a list walk, it isn't a
 * guarantee.
 */
@Injectable()
export class AccountThrottleGuard implements CanActivate {
  private readonly checks = new Map<string, number[]>();
  private lastSweep = Date.now();

  /** Which ration this guard enforces, and how a refusal is worded. */
  protected readonly ration: {
    ttl: number;
    limit: number;
    code: string;
    message: string;
  } = {
    ...SLUG_CHECK_ACCOUNT_THROTTLE,
    code: SLUG_CHECK_DAILY_LIMIT_CODE,
    message: "You've used today's address checks for this account.",
  };

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const account = getUserSub(http.getRequest<AuthenticatedRequest>());
    const { ttl, limit, code, message } = this.ration;
    const now = Date.now();
    this.sweep(now, ttl);

    const recent = (this.checks.get(account) ?? []).filter(
      (at) => at > now - ttl,
    );
    this.checks.set(account, recent);

    if (recent.length >= limit) {
      http
        .getResponse<Response>()
        .header(
          'Retry-After',
          String(Math.ceil((recent[0] + ttl - now) / 1000)),
        );
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code,
          message,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    recent.push(now);
    return true;
  }

  /** Forgets accounts with nothing recent, at most once per window. */
  private sweep(now: number, ttl: number): void {
    if (now - this.lastSweep < ttl) return;
    this.lastSweep = now;
    for (const [account, times] of this.checks) {
      if (times.every((at) => at <= now - ttl)) this.checks.delete(account);
    }
  }
}
