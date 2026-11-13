import { Injectable } from '@nestjs/common';
import {
  CLAIM_REQUEST_ACCOUNT_THROTTLE,
  CLAIM_REQUEST_DAILY_LIMIT_CODE,
} from '../../config/throttle';
import { AccountThrottleGuard } from '../../membership/account-throttle.guard';

/**
 * A tighter daily ration per account for claim requests (Chunk 11): each one
 * lands in the admins' queue, and a member needs one or two at most.
 */
@Injectable()
export class ClaimRequestThrottleGuard extends AccountThrottleGuard {
  protected override readonly ration = {
    ...CLAIM_REQUEST_ACCOUNT_THROTTLE,
    code: CLAIM_REQUEST_DAILY_LIMIT_CODE,
    message:
      "You've sent today's claim requests for this account. Please come back tomorrow.",
  };
}
