import { Injectable } from '@nestjs/common';
import {
  MODERATION_ACCOUNT_THROTTLE,
  MODERATION_DAILY_LIMIT_CODE,
} from '../../config/throttle';
import { AccountThrottleGuard } from '../../membership/account-throttle.guard';

/**
 * The daily ration of moderation actions per admin account (Chunk 13 review
 * L-5), separate from the member-write ration: hiding a hundred spam comments
 * must not stop the admin from commenting or voting that day.
 */
@Injectable()
export class ModerationThrottleGuard extends AccountThrottleGuard {
  protected override readonly ration = {
    ...MODERATION_ACCOUNT_THROTTLE,
    code: MODERATION_DAILY_LIMIT_CODE,
    message:
      "You've made today's moderation actions for this account. Please come back tomorrow.",
  };
}
