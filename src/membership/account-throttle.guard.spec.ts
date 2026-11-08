import { type ExecutionContext, HttpException } from '@nestjs/common';
import {
  SLUG_CHECK_ACCOUNT_THROTTLE,
  SLUG_CHECK_DAILY_LIMIT_CODE,
} from '../config/throttle';
import { AccountThrottleGuard } from './account-throttle.guard';

const { limit } = SLUG_CHECK_ACCOUNT_THROTTLE;
const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date('2026-11-08T12:00:00.000Z').getTime();

function contextFor(sub: string, header = jest.fn()) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ auth: { payload: { sub } } }),
      getResponse: () => ({ header }),
    }),
  } as unknown as ExecutionContext;
}

function refusal(guard: AccountThrottleGuard, sub: string, header = jest.fn()) {
  try {
    guard.canActivate(contextFor(sub, header));
  } catch (error) {
    return error as HttpException;
  }
  return undefined;
}

describe('AccountThrottleGuard', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function exhaust(guard: AccountThrottleGuard, sub: string) {
    for (let check = 0; check < limit; check++) {
      guard.canActivate(contextFor(sub));
    }
  }

  it('allows the whole ration and refuses the next check', () => {
    const guard = new AccountThrottleGuard();
    exhaust(guard, 'user_a');

    const refused = refusal(guard, 'user_a');
    expect(refused?.getStatus()).toBe(429);
    expect(refused?.getResponse()).toMatchObject({
      code: SLUG_CHECK_DAILY_LIMIT_CODE,
    });
  });

  it('opens at exactly 24 hours, not a millisecond before', () => {
    const guard = new AccountThrottleGuard();
    // Later than the guard's first sweep, so the sweep cannot be what opens it.
    const firstCheck = START + 1000;
    jest.setSystemTime(firstCheck);
    exhaust(guard, 'user_a');

    jest.setSystemTime(firstCheck + DAY_MS - 1);
    expect(refusal(guard, 'user_a')?.getStatus()).toBe(429);

    jest.setSystemTime(firstCheck + DAY_MS);
    expect(refusal(guard, 'user_a')).toBeUndefined();
  });

  it('keeps the ration rolling: only the oldest checks age out', () => {
    const guard = new AccountThrottleGuard();
    exhaust(guard, 'user_a');
    jest.setSystemTime(START + 1000);
    expect(refusal(guard, 'user_a')?.getStatus()).toBe(429);

    jest.setSystemTime(START + DAY_MS);
    exhaust(guard, 'user_a');
    expect(refusal(guard, 'user_a')?.getStatus()).toBe(429);
  });

  it('says when to come back', () => {
    const guard = new AccountThrottleGuard();
    exhaust(guard, 'user_a');
    jest.setSystemTime(START + 1000);

    const header = jest.fn();
    refusal(guard, 'user_a', header);
    expect(header).toHaveBeenCalledWith(
      'Retry-After',
      String(DAY_MS / 1000 - 1),
    );
  });

  it('keeps a separate count per account', () => {
    const guard = new AccountThrottleGuard();
    exhaust(guard, 'user_a');
    expect(refusal(guard, 'user_b')).toBeUndefined();
  });

  it('holds no timers another key could cancel', () => {
    const guard = new AccountThrottleGuard();
    exhaust(guard, 'user_a');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('forgets idle accounts after a window, keeping active ones', () => {
    const guard = new AccountThrottleGuard();
    guard.canActivate(contextFor('user_idle'));
    jest.setSystemTime(START + DAY_MS - 1);
    guard.canActivate(contextFor('user_active'));

    jest.setSystemTime(START + DAY_MS);
    guard.canActivate(contextFor('user_new'));

    const tracked = Reflect.get(guard, 'checks') as Map<string, number[]>;
    expect([...tracked.keys()].sort()).toEqual(['user_active', 'user_new']);
  });
});
