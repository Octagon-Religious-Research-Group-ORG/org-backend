/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
// Round-2 review fixes for Suggested Fragments (L1, L2, L4): fakes that keep
// state, so each test can see what a second request or a second search does.
import { Types } from 'mongoose';
import { Logger } from '@nestjs/common';
import {
  FRAGMENTS_OFF,
  SearchFragmentsService,
  windowIndex,
} from './search-fragments.service';

const exec = (value: unknown = {}) => ({ exec: () => Promise.resolve(value) });
const chain = (value: unknown) => {
  const query = {
    select: () => query,
    lean: () => query,
    exec: () => Promise.resolve(value),
  };
  return query;
};

const NOW = new Date('2026-11-13T12:00:00Z');

/** A keyed store with `updateOne` upserts and `findOne`, like the models. */
function store() {
  const rows = new Map<string, Record<string, any>>();
  return {
    rows,
    findOne: jest.fn((filter: { _id: string }) =>
      chain(rows.get(filter._id) ?? null),
    ),
    updateOne: jest.fn(
      (filter: { _id: string }, update: Record<string, any>) => {
        const existed = rows.has(filter._id);
        const row = rows.get(filter._id) ?? { _id: filter._id };
        if (!existed) Object.assign(row, update.$setOnInsert ?? {});
        for (const [key, by] of Object.entries(update.$inc ?? {})) {
          row[key] = (row[key] ?? 0) + (by as number);
        }
        Object.assign(row, update.$set ?? {});
        rows.set(filter._id, row);
        return exec({ upsertedCount: existed ? 0 : 1 });
      },
    ),
  };
}

function build(
  options: {
    counted?: Array<{ _id: string; searchers: number }>;
    hidden?: string[];
  } = {},
) {
  const windows = {
    ...store(),
    aggregate: jest.fn(() => exec(options.counted ?? [])),
  };
  const hides = {
    find: jest.fn(() =>
      chain((options.hidden ?? []).map((term) => ({ _id: term }))),
    ),
    updateOne: jest.fn(() => exec()),
  };
  let scope = { listed: [] as Types.ObjectId[], full: [] as Types.ObjectId[] };
  let generation = 0;
  const search = {
    publicPhraseCount: jest.fn((term: string) => Promise.resolve(term ? 1 : 0)),
    guestScope: jest.fn(() => Promise.resolve(scope)),
    indexGeneration: jest.fn(() => generation),
  };
  const pairs = store();
  const visitors = store();
  const service = new (SearchFragmentsService as any)(
    windows,
    hides,
    search,
    { record: jest.fn(() => Promise.resolve({})) },
    {
      get: (key: string, fallback: unknown) =>
        key === 'CLERK_SECRET_KEY' ? 'synthetic-secret' : fallback,
    },
    pairs,
    visitors,
  ) as SearchFragmentsService;
  jest
    .spyOn((service as any).logger, 'warn')
    .mockImplementation(() => undefined);
  return {
    service,
    windows,
    search,
    pairs,
    visitors,
    setScope: (next: typeof scope) => (scope = next),
    bump: () => (generation += 1),
  };
}

describe('Suggested Fragments, round-2 review', () => {
  it('checks the term is public BEFORE remembering the searcher (L1)', async () => {
    const { service, search, windows } = build();
    search.publicPhraseCount.mockResolvedValueOnce(0);
    await service.record('lamp light', 1, 'ip:one', NOW);
    // The page became public; the same person searches again: counted.
    await service.record('lamp light', 1, 'ip:one', NOW);
    expect(windows.updateOne).toHaveBeenCalledTimes(1);
  });

  it('counts at most 50 different terms per visitor per window (L1)', async () => {
    const { service, windows } = build();
    for (let n = 1; n <= 60; n += 1) {
      await service.record(`topic ${n}`, 1, 'ip:busy', NOW);
    }
    expect(windows.updateOne.mock.calls.length).toBeLessThanOrEqual(50);
    // Another visitor is unaffected.
    await service.record('topic 1', 1, 'ip:calm', NOW);
    expect(windows.rows.get(`${windowIndex(NOW, 30)}|topic 1`)?.searchers).toBe(
      2,
    );
  });

  it('reuses the public check until the index or what a guest may see changes (L2)', async () => {
    const counted = [
      { _id: 'lamp light', searchers: 9 },
      { _id: 'copper bell', searchers: 8 },
    ];
    const { service, search, setScope, bump } = build({ counted });
    expect(await service.fragments(NOW)).toEqual(['lamp light', 'copper bell']);
    const checks = () => search.publicPhraseCount.mock.calls.length;
    const first = checks();
    await service.fragments(new Date(NOW.getTime() + 1000));
    expect(checks()).toBe(first);
    // A page becomes private: the guest scope differs, so it checks again.
    setScope({ listed: [new Types.ObjectId()], full: [] });
    search.publicPhraseCount.mockImplementation((term: string) =>
      Promise.resolve(term === 'lamp light' ? 0 : 1),
    );
    expect(await service.fragments(new Date(NOW.getTime() + 2000))).toEqual([
      'copper bell',
    ]);
    const second = checks();
    // The index changed: checks again.
    bump();
    await service.fragments(new Date(NOW.getTime() + 3000));
    expect(checks()).toBeGreaterThan(second);
  });

  it('keeps out every term containing a hidden word (L4)', async () => {
    const { service } = build({
      counted: [
        { _id: 'lamp light', searchers: 9 },
        { _id: 'lamplight', searchers: 8 },
      ],
      hidden: ['lamp'],
    });
    expect(await service.fragments(NOW)).toEqual(['lamplight']);
    const view = await service.adminView(NOW);
    expect(view.find((row) => row.term === 'lamp light')).toEqual(
      expect.objectContaining({
        hidden: false,
        shown: false,
        blockedBy: 'lamp',
      }),
    );
  });
});

describe('Suggested Fragments without a server secret (M-A)', () => {
  it('counts nothing, suggests nothing, and says so once', async () => {
    const windows = { updateOne: jest.fn(), aggregate: jest.fn() };
    const search = { publicPhraseCount: jest.fn(), guestScope: jest.fn() };
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const service = new SearchFragmentsService(
      windows as never,
      {} as never,
      search as never,
      {} as never,
      { get: (_key: string, fallback: unknown) => fallback } as never,
      {} as never,
    );
    expect(warn).toHaveBeenCalledWith(FRAGMENTS_OFF);
    await service.record('lamp', 1, 'ip:1', NOW);
    expect(await service.fragments(NOW)).toEqual([]);
    expect(search.publicPhraseCount).not.toHaveBeenCalled();
    expect(windows.updateOne).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('Suggested Fragments per-searcher memory (L1)', () => {
  it('stops counting new searchers once the window remembers too many', async () => {
    const { service, windows } = build();
    const counts = (service as any).perVisitor;
    (service as any).visitorCounts(windowIndex(NOW, 30));
    for (let n = 0; n < 100_000; n += 1) {
      (service as any).perVisitor.counts.set(`v${n}`, 1);
    }
    expect(counts).toBeDefined();
    await service.record('lamp', 1, 'ip:new', NOW);
    expect(windows.updateOne).not.toHaveBeenCalled();
  });
});
