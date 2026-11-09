import { type ExecutionContext, HttpException } from '@nestjs/common';
import {
  MEMBER_WRITE_ACCOUNT_THROTTLE,
  MEMBER_WRITE_DAILY_LIMIT_CODE,
} from '../config/throttle';
import { MemberWriteThrottleGuard } from './member-write-throttle.guard';

function contextFor(sub: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ auth: { payload: { sub } } }),
      getResponse: () => ({ header: jest.fn() }),
    }),
  } as unknown as ExecutionContext;
}

describe('MemberWriteThrottleGuard', () => {
  it('allows the ration, refuses the next write, and names its own limit', () => {
    const guard = new MemberWriteThrottleGuard();
    for (let write = 0; write < MEMBER_WRITE_ACCOUNT_THROTTLE.limit; write++) {
      expect(guard.canActivate(contextFor('u1'))).toBe(true);
    }
    let refusal: HttpException | undefined;
    try {
      guard.canActivate(contextFor('u1'));
    } catch (error) {
      refusal = error as HttpException;
    }
    expect(refusal?.getStatus()).toBe(429);
    expect(refusal?.getResponse()).toMatchObject({
      code: MEMBER_WRITE_DAILY_LIMIT_CODE,
    });
    expect(guard.canActivate(contextFor('u2'))).toBe(true);
  });
});
