import { type ExecutionContext, HttpException } from '@nestjs/common';
import {
  CLAIM_REQUEST_ACCOUNT_THROTTLE,
  CLAIM_REQUEST_DAILY_LIMIT_CODE,
} from '../../config/throttle';
import { ClaimRequestThrottleGuard } from './claim-request-throttle.guard';

function contextFor(sub: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ auth: { payload: { sub } } }),
      getResponse: () => ({ header: jest.fn() }),
    }),
  } as unknown as ExecutionContext;
}

describe('ClaimRequestThrottleGuard', () => {
  it('allows the daily ration, refuses the next request with its own code', () => {
    const guard = new ClaimRequestThrottleGuard();
    for (let n = 0; n < CLAIM_REQUEST_ACCOUNT_THROTTLE.limit; n++) {
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
      code: CLAIM_REQUEST_DAILY_LIMIT_CODE,
    });
    expect(guard.canActivate(contextFor('u2'))).toBe(true);
  });
});
