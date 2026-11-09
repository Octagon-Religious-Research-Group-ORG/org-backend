import { Injectable } from '@nestjs/common';
import { AccountThrottleGuard } from '../membership/account-throttle.guard';
import {
  MEMBER_WRITE_ACCOUNT_THROTTLE,
  MEMBER_WRITE_DAILY_LIMIT_CODE,
} from '../config/throttle';

/**
 * A daily ration per account across every member-page write, on top of the
 * per-visitor limit (`@WriteThrottle()`), which an account can dodge by
 * changing address. One instance per module, so the routes share the count.
 */
@Injectable()
export class MemberWriteThrottleGuard extends AccountThrottleGuard {
  protected override readonly ration = {
    ...MEMBER_WRITE_ACCOUNT_THROTTLE,
    code: MEMBER_WRITE_DAILY_LIMIT_CODE,
    message:
      "You've made today's changes for this account. Please come back tomorrow.",
  };
}
