/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/only-throw-error */
import { BadRequestException } from '@nestjs/common';
import {
  CANDIDATES_CACHE_MS,
  DEFAULT_HIDE_REASON,
  ELIGIBLE_CACHE_MS,
  fragmentTerm,
  MAX_FRAGMENTS,
  SearchFragmentsService,
  windowIndex,
} from './search-fragments.service';

const chain = (value: unknown) => {
  const query = {
    select: () => query,
    lean: () => query,
    exec: () => Promise.resolve(value),
  };
  return query;
};
const exec = (value: unknown = {}) => ({ exec: () => Promise.resolve(value) });

const NOW = new Date('2026-11-13T12:00:00Z');
const WINDOW = windowIndex(NOW, 30);
const SCOPE = { listed: [], full: [] };

function build(
  counted: Array<{ _id: string; searchers: number }> = [],
  hidden: string[] = [],
  publicCount = 1,
  config: Record<string, unknown> = {},
) {
  const windows = {
    updateOne: jest.fn(() => exec()),
    aggregate: jest.fn(() => exec(counted)),
  };
  const hides = {
    updateOne: jest.fn(() => exec()),
    find: jest.fn(() => chain(hidden.map((term) => ({ _id: term })))),
  };
  const search = {
    publicPhraseCount: jest.fn((term: string) =>
      Promise.resolve(term ? publicCount : 0),
    ),
    guestScope: jest.fn(() => Promise.resolve(SCOPE)),
    indexGeneration: jest.fn(() => 0),
  };
  const seen = new Set<string>();
  const pairs = {
    updateOne: jest.fn((filter: { _id: string }) => {
      const fresh = !seen.has(filter._id);
      seen.add(filter._id);
      return exec({ upsertedCount: fresh ? 1 : 0 });
    }),
  };
  const log = { record: jest.fn(() => Promise.resolve({})) };
  const service = new SearchFragmentsService(
    windows as never,
    hides as never,
    search as never,
    log as never,
    {
      get: (key: string, fallback: unknown) =>
        ({ CLERK_SECRET_KEY: 'synthetic-secret', ...config })[key] ?? fallback,
    } as never,
    pairs as never,
  );
  const warn = jest
    .spyOn((service as any).logger, 'warn')
    .mockImplementation(() => undefined);
  return { service, windows, hides, search, log, warn, pairs };
}

describe('fragment helpers', () => {
  it('puts a date in a fixed window and a term in one form', () => {
    expect(windowIndex(new Date('1970-01-30T23:59:59Z'), 30)).toBe(0);
    expect(windowIndex(new Date('1970-01-31T00:00:00Z'), 30)).toBe(1);
    expect(fragmentTerm(' Lamp  Light ')).toBe('lamp light');
    expect(fragmentTerm('a@b.test')).toBeUndefined();
  });
});

describe('SearchFragmentsService.record', () => {
  it('counts a search once per searcher per window, only when every word is public', async () => {
    const { service, windows, search } = build();
    await service.record('Lamp Light', 3, 'ip:1', NOW);
    await service.record(
      'lamp light',
      3,
      'ip:1',
      new Date(NOW.getTime() + 86_400_000),
    );
    // The public check runs first, every time; only the first is counted.
    expect(search.publicPhraseCount).toHaveBeenCalledTimes(2);
    expect(search.publicPhraseCount).toHaveBeenCalledWith('lamp light');
    expect(windows.updateOne).toHaveBeenCalledTimes(1);
    expect(windows.updateOne).toHaveBeenCalledWith(
      { _id: `${WINDOW}|lamp light` },
      {
        $inc: { searchers: 1 },
        $setOnInsert: {
          term: 'lamp light',
          window: WINDOW,
          expiresAt: new Date((WINDOW + 2) * 30 * 86_400_000),
        },
      },
      { upsert: true },
    );
  });

  it('never counts a term with a word only members can read', async () => {
    const { service, windows } = build([], [], 0);
    await service.record('privateword commonword', 5, 'ip:1', NOW);
    expect(windows.updateOne).not.toHaveBeenCalled();
  });

  it('ignores searches that found nothing or are not fragment-shaped', async () => {
    const { service, windows } = build();
    await service.record('lamp', 0, 'ip:1', NOW);
    await service.record('a@b.test', 2, 'ip:1', NOW);
    expect(windows.updateOne).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const { service, windows, warn } = build();
    windows.updateOne.mockImplementationOnce(() => {
      throw new Error('down');
    });
    await expect(
      service.record('lamp', 1, 'ip:1', NOW),
    ).resolves.toBeUndefined();
    windows.updateOne.mockImplementationOnce(() => {
      throw 'plain';
    });
    await service.record('lamp', 1, 'ip:2', NOW);
    expect(warn).toHaveBeenCalledWith('A search could not be counted: down');
    expect(warn).toHaveBeenCalledWith('A search could not be counted: plain');
  });

  it('uses the configured window', async () => {
    const { service, windows } = build([], [], 1, {
      SEARCH_FRAGMENT_WINDOW_DAYS: 7,
    });
    await service.record('lamp', 1, 'ip:1', NOW);
    const window = windowIndex(NOW, 7);
    expect((windows.updateOne.mock.calls as unknown[][])[0][0]).toEqual({
      _id: `${window}|lamp`,
    });
  });
});

describe('SearchFragmentsService lists', () => {
  it('shows terms with enough searchers that still match public content, not hidden ones', async () => {
    const { service, windows, search } = build(
      [
        { _id: 'lamp', searchers: 9 },
        { _id: 'gone', searchers: 8 },
        { _id: 'hidden word', searchers: 7 },
        { _id: 'a@b', searchers: 6 },
      ],
      ['hidden word', 'old hide'],
    );
    search.publicPhraseCount.mockImplementation((term: string) =>
      Promise.resolve(term === 'gone' ? 0 : 1),
    );
    expect(await service.adminView(NOW)).toEqual([
      { term: 'lamp', searchers: 9, hidden: false, shown: true },
      { term: 'gone', searchers: 8, hidden: false, shown: false },
      { term: 'hidden word', searchers: 7, hidden: true, shown: false },
      { term: 'a@b', searchers: 6, hidden: false, shown: false },
      { term: 'old hide', searchers: 0, hidden: true, shown: false },
    ]);
    // One guest scope for every check.
    expect(search.guestScope).toHaveBeenCalledTimes(1);
    expect(search.publicPhraseCount).toHaveBeenCalledWith('lamp', SCOPE);
    const pipeline = (
      windows.aggregate.mock.calls as unknown[][]
    )[0][0] as any[];
    expect(pipeline[0]).toEqual({
      $match: { window: { $in: [WINDOW - 1, WINDOW] } },
    });
    expect(pipeline[1].$group.searchers).toEqual({ $max: '$searchers' });
    expect(pipeline[2]).toEqual({ $match: { searchers: { $gte: 5 } } });
  });

  it('reads no scope when nothing is eligible', async () => {
    const { service, search } = build([{ _id: 'a@b', searchers: 9 }]);
    await service.adminView(NOW);
    expect(search.guestScope).not.toHaveBeenCalled();
  });

  it('caches candidates, but checks each one on every request', async () => {
    const many = Array.from({ length: MAX_FRAGMENTS + 3 }, (_, n) => ({
      _id: `term ${String.fromCharCode(97 + n)}`,
      searchers: 20 - n,
    }));
    const { service, search, windows } = build(many);
    const first = await service.fragments(NOW);
    expect(first).toHaveLength(MAX_FRAGMENTS);
    expect(search.publicPhraseCount).toHaveBeenCalledTimes(MAX_FRAGMENTS);
    // Within a minute and with nothing changed, the answer is reused.
    expect(await service.fragments(new Date(NOW.getTime() + 1))).toBe(first);
    // After it, each one is checked again: one that stopped matching goes.
    search.publicPhraseCount.mockImplementation((term: string) =>
      Promise.resolve(term === 'term a' ? 0 : 1),
    );
    const second = await service.fragments(
      new Date(NOW.getTime() + ELIGIBLE_CACHE_MS),
    );
    expect(second).not.toContain('term a');
    expect(second).toHaveLength(MAX_FRAGMENTS);
    expect(windows.aggregate).toHaveBeenCalledTimes(1);
    await service.fragments(new Date(NOW.getTime() + CANDIDATES_CACHE_MS));
    expect(windows.aggregate).toHaveBeenCalledTimes(2);
  });

  it('reads the candidates again after a count changes', async () => {
    const { service, windows } = build();
    await service.fragments(NOW);
    await service.record('lamp', 1, 'ip:1', NOW);
    await service.fragments(NOW);
    expect(windows.aggregate).toHaveBeenCalledTimes(2);
  });
});

describe('SearchFragmentsService.setHidden', () => {
  it('stores the decision, logs it and drops the cache', async () => {
    const { service, hides, log, windows } = build();
    await service.fragments(NOW);
    expect(
      await service.setHidden(' Lamp ', true, 'user_admin', ' why '),
    ).toEqual({
      term: 'lamp',
      hidden: true,
    });
    expect(hides.updateOne).toHaveBeenCalledWith(
      { _id: 'lamp' },
      { $set: { hidden: true, at: expect.any(Date), by: 'user_admin' } },
      { upsert: true },
    );
    expect(log.record).toHaveBeenCalledWith({
      actorUserId: 'user_admin',
      action: 'search.fragment.hidden',
      targetType: 'search-fragment',
      targetId: 'lamp',
      reason: 'why',
    });
    await service.setHidden('lamp', false, 'user_admin');
    expect(log.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'search.fragment.shown',
        reason: DEFAULT_HIDE_REASON,
      }),
    );
    await service.fragments(NOW);
    expect(windows.aggregate).toHaveBeenCalledTimes(2);
  });

  it('refuses a term that could never be a fragment', async () => {
    const { service } = build();
    await expect(service.setHidden('a@b', true, 'user_admin')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('SearchFragmentsService clock', () => {
  it('uses the current time by default', async () => {
    const { service, windows } = build();
    await service.record('lamp', 1, 'ip:1');
    expect(windows.updateOne).toHaveBeenCalled();
    expect(await service.fragments()).toEqual([]);
    expect(await service.adminView()).toEqual([]);
  });
});
