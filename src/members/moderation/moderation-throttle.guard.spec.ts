import { type ExecutionContext, HttpException } from '@nestjs/common';
import {
  MEMBER_WRITE_ACCOUNT_THROTTLE,
  MODERATION_ACCOUNT_THROTTLE,
  MODERATION_DAILY_LIMIT_CODE,
} from '../../config/throttle';
import { MemberWriteThrottleGuard } from '../member-write-throttle.guard';
import { ModerationThrottleGuard } from './moderation-throttle.guard';

function contextFor(sub: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ auth: { payload: { sub } } }),
      getResponse: () => ({ header: jest.fn() }),
    }),
  } as unknown as ExecutionContext;
}

describe('ModerationThrottleGuard (Chunk 13 review L-5)', () => {
  it('has its own, larger ration, kept apart from member writes', () => {
    expect(MODERATION_ACCOUNT_THROTTLE.limit).toBeGreaterThan(
      MEMBER_WRITE_ACCOUNT_THROTTLE.limit,
    );
    const guard = new ModerationThrottleGuard();
    const memberWrites = new MemberWriteThrottleGuard();
    for (let n = 0; n < MODERATION_ACCOUNT_THROTTLE.limit; n++) {
      expect(guard.canActivate(contextFor('user_admin'))).toBe(true);
    }
    let refusal: HttpException | undefined;
    try {
      guard.canActivate(contextFor('user_admin'));
    } catch (error) {
      refusal = error as HttpException;
    }
    expect(refusal?.getStatus()).toBe(429);
    expect(refusal?.getResponse()).toMatchObject({
      code: MODERATION_DAILY_LIMIT_CODE,
    });
    // The admin's own commenting and voting are untouched.
    expect(memberWrites.canActivate(contextFor('user_admin'))).toBe(true);
  });
});
