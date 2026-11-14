import { Logger } from '@nestjs/common';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { ReportQuotaStore, utcDay } from './report-quota.store';

const NOW = new Date('2026-11-13T23:30:00.000Z');

function build() {
  const quotas = fakeModel([], { unique: [['reporterUserId', 'day']] });
  return { quotas, store: new ReportQuotaStore(quotas as never) };
}

describe('ReportQuotaStore (Chunk 13 review M-1)', () => {
  it('counts one UTC day, up to the limit, then refuses', async () => {
    const { quotas, store } = build();
    expect(utcDay(NOW)).toBe('2026-11-13');
    for (let n = 0; n < 3; n++) {
      await expect(store.take('user_a', 3, NOW)).resolves.toBe('2026-11-13');
    }
    await expect(store.take('user_a', 3, NOW)).resolves.toBeUndefined();
    expect(quotas.docs).toEqual([
      expect.objectContaining({
        _id: 'user_a|2026-11-13',
        reporterUserId: 'user_a',
        day: '2026-11-13',
        n: 3,
        expiresAt: new Date('2026-11-15T00:00:00.000Z'),
      }),
    ]);
    // Another reporter, and the next day, start at zero.
    await expect(store.take('user_b', 3, NOW)).resolves.toBe('2026-11-13');
    await expect(
      store.take('user_a', 3, new Date('2026-11-14T00:00:01.000Z')),
    ).resolves.toBe('2026-11-14');
  });

  it('uses the current time by default', async () => {
    const { store } = build();
    await expect(store.take('user_a', 1)).resolves.toBe(utcDay(new Date()));
  });

  it('ignores a lost race to create the day’s row (review F2)', async () => {
    const { quotas, store } = build();
    await store.take('user_a', 3, NOW);
    jest.spyOn(quotas, 'updateOne').mockReturnValueOnce({
      exec: () =>
        Promise.reject(Object.assign(new Error('E11000'), { code: 11000 })),
    });
    await expect(store.take('user_a', 3, NOW)).resolves.toBe('2026-11-13');
    expect(quotas.docs[0]).toMatchObject({ n: 2 });
  });

  it('passes on a failure that is not the cap', async () => {
    const { quotas, store } = build();
    jest.spyOn(quotas, 'updateOne').mockReturnValueOnce({
      exec: () => Promise.reject(new Error('synthetic outage')),
    });
    await expect(store.take('user_a', 3, NOW)).rejects.toThrow(
      'synthetic outage',
    );
  });

  it('gives a slot back, never below zero, and only warns when it cannot', async () => {
    const { quotas, store } = build();
    await store.take('user_a', 3, NOW);
    await store.giveBack('user_a', '2026-11-13');
    await store.giveBack('user_a', '2026-11-13');
    expect(quotas.docs[0]).toMatchObject({ n: 0 });
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    for (const failure of [new Error('synthetic outage'), 'raw failure']) {
      jest.spyOn(quotas, 'updateOne').mockReturnValueOnce({
        // A driver can reject with anything; the second case is not an Error.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        exec: () => Promise.reject(failure),
      });
      await expect(
        store.giveBack('user_a', '2026-11-13'),
      ).resolves.toBeUndefined();
    }
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('synthetic outage'),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('raw failure'));
    warn.mockRestore();
  });
});
