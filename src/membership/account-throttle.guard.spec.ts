import type { ExecutionContext } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';
import {
  DEFAULT_THROTTLE,
  SLUG_CHECK_ACCOUNT_THROTTLE,
} from '../config/throttle';
import { AccountThrottleGuard } from './account-throttle.guard';

class Route {}
const handler = () => undefined;

function contextFor(sub: string) {
  const request = { auth: { payload: { sub } }, ip: '1.2.3.4', headers: {} };
  return {
    getHandler: () => handler,
    getClass: () => Route,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ header: jest.fn() }),
    }),
  } as unknown as ExecutionContext;
}

describe('AccountThrottleGuard', () => {
  let moduleRef: TestingModule;

  // The storage holds a 24-hour timer per key; closing clears them, or Jest
  // never exits when this file runs on its own.
  afterEach(() => moduleRef.close());

  async function setup() {
    moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([DEFAULT_THROTTLE])],
      providers: [AccountThrottleGuard],
    }).compile();
    const guard = moduleRef.get(AccountThrottleGuard);
    await guard.onModuleInit();
    const storage = moduleRef.get<ThrottlerStorage>(ThrottlerStorage);
    return { guard, increment: jest.spyOn(storage, 'increment') };
  }

  it('counts against the daily account ration, not the route or site limit', async () => {
    const { guard, increment } = await setup();
    await expect(guard.canActivate(contextFor('user_a'))).resolves.toBe(true);
    const [, ttl, limit, blockDuration] = increment.mock.calls[0];
    expect({ ttl, limit, blockDuration }).toEqual({
      ttl: SLUG_CHECK_ACCOUNT_THROTTLE.ttl,
      limit: SLUG_CHECK_ACCOUNT_THROTTLE.limit,
      blockDuration: SLUG_CHECK_ACCOUNT_THROTTLE.ttl,
    });
  });

  it('keeps a separate count per account, whatever the IP', async () => {
    const { guard, increment } = await setup();
    await guard.canActivate(contextFor('user_a'));
    await guard.canActivate(contextFor('user_b'));
    await guard.canActivate(contextFor('user_a'));
    const [first, second, third] = increment.mock.calls.map(([key]) => key);
    expect(first).not.toBe(second);
    expect(first).toBe(third);
  });
});
