import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';
import { getUserSub } from '../auth/auth.helpers';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { SLUG_CHECK_ACCOUNT_THROTTLE } from '../config/throttle';

/**
 * The address check's daily ration per account. A separate guard because the
 * global ThrottlerGuard runs before the login check and so can only see an IP;
 * this one runs after it, on the signed-in account. Same in-memory storage.
 */
@Injectable()
export class AccountThrottleGuard extends ThrottlerGuard {
  protected handleRequest(props: ThrottlerRequest): Promise<boolean> {
    const { limit, ttl } = SLUG_CHECK_ACCOUNT_THROTTLE;
    return super.handleRequest({
      ...props,
      limit,
      ttl,
      blockDuration: ttl,
      getTracker: (request) =>
        getUserSub(request as unknown as AuthenticatedRequest),
    });
  }
}
