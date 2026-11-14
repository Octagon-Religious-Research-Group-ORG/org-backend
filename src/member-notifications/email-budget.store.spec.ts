import { Logger } from '@nestjs/common';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { EmailBudgetStore, nextUtcDay } from './email-budget.store';

function config(values: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    PUBLIC_APP_URL: 'https://org.example.test',
    CLERK_SECRET_KEY: 'sk_test_synthetic',
    EMAIL_DAILY_LIMIT: 5,
    EMAIL_IMMEDIATE_RESERVE: 2,
    ...values,
  };
  return {
    get: (key: string) => all[key],
    getOrThrow: (key: string) => all[key],
  } as never;
}

const NOW = new Date('2026-11-13T15:00:00Z');

describe('EmailBudgetStore (Chunk 14)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => warn.mockRestore());

  it('lets digests stop short of the immediate reserve, immediates use the whole day', async () => {
    const model = fakeModel();
    const store = new EmailBudgetStore(model as never, config());
    expect(store.limitFor('digest')).toBe(3);
    expect(store.limitFor('immediate')).toBe(5);
    const digests: boolean[] = [];
    for (let n = 0; n < 4; n++) digests.push(await store.take('digest', NOW));
    expect(digests).toEqual([true, true, true, false]);
    expect(await store.take('immediate', NOW)).toBe(true);
    expect(await store.take('immediate', NOW)).toBe(true);
    expect(await store.take('immediate', NOW)).toBe(false);
    // One row for the day, keyed by the day itself, with its own expiry.
    expect(model.docs).toHaveLength(1);
    expect(model.docs[0]).toMatchObject({ _id: '2026-11-13', n: 5 });
    expect(model.docs[0].expiresAt).toEqual(new Date('2026-11-21T00:00:00Z'));
    // The limit is logged once a day, and its first moment kept.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await store.status(NOW)).toEqual({
      day: '2026-11-13',
      sent: 5,
      dailyLimit: 5,
      immediateReserve: 2,
      limitHitAt: NOW.toISOString(),
    });
    // A new day starts from zero.
    expect(await store.take('digest', nextUtcDay(NOW))).toBe(true);
  });

  it('says nothing was sent on a day with no row, and never reserves more than the day', async () => {
    const store = new EmailBudgetStore(
      fakeModel() as never,
      config({ EMAIL_DAILY_LIMIT: 2, EMAIL_IMMEDIATE_RESERVE: 9 }),
    );
    expect(await store.status(NOW)).toEqual({
      day: '2026-11-13',
      sent: 0,
      dailyLimit: 2,
      immediateReserve: 2,
    });
    expect(await store.take('digest', NOW)).toBe(false);
    // Today, when no time is given.
    expect(await store.take('immediate')).toBe(true);
    expect((await store.status()).sent).toBe(1);
  });

  it('survives two first sends of the day racing, and passes other failures on', async () => {
    let fail: unknown;
    // The other send made the day's row first.
    const model = fakeModel([{ _id: '2026-11-13', n: 0, expiresAt: NOW }], {
      beforeWrite: () => {
        if (fail) {
          const error = fail;
          fail = undefined;
          throw error as Error;
        }
      },
    });
    const store = new EmailBudgetStore(model as never, config());
    // This upsert lost the race; the slot is still taken.
    fail = Object.assign(new Error('dup'), { code: 11000 });
    expect(await store.take('immediate', NOW)).toBe(true);
    expect(model.docs[0].n).toBe(1);
    fail = new Error('down');
    await expect(store.take('immediate', NOW)).rejects.toThrow('down');
  });

  it('knows the next UTC day', () => {
    expect(nextUtcDay(new Date('2026-12-31T23:59:59Z'))).toEqual(
      new Date('2027-01-01T00:00:00Z'),
    );
  });
});
