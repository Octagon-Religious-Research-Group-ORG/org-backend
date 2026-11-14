/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/only-throw-error */
import { BadRequestException } from '@nestjs/common';
import { GUEST_VIEWER, type Viewer } from '../members/profile-access';
import {
  DEFAULT_HIDE_REASON,
  FRAGMENTS_CACHE_MS,
  MAX_FRAGMENTS,
  SearchFragmentsService,
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

const MEMBER: Viewer = {
  kind: 'named-member',
  userId: 'user_x',
  isAdmin: false,
};
const NOW = new Date('2026-11-13T12:00:00Z');

function build(
  counted: Array<{ _id: string; searchers: number }> = [],
  hidden: string[] = [],
  publicTotal = 1,
  config: Record<string, number> = {},
) {
  const days = {
    updateOne: jest.fn(() => exec()),
    aggregate: jest.fn(() => exec(counted)),
  };
  const hides = {
    updateOne: jest.fn(() => exec()),
    find: jest.fn(() => chain(hidden.map((term) => ({ _id: term })))),
  };
  const search = {
    count: jest.fn((term: string) => Promise.resolve(term ? publicTotal : 0)),
  };
  const log = { record: jest.fn(() => Promise.resolve({})) };
  const service = new SearchFragmentsService(
    days as never,
    hides as never,
    search as never,
    log as never,
    {
      get: (key: string, fallback: number) => config[key] ?? fallback,
    } as never,
  );
  const warn = jest
    .spyOn((service as any).logger, 'warn')
    .mockImplementation(() => undefined);
  return { service, days, hides, search, log, warn };
}

describe('SearchFragmentsService.record', () => {
  it('counts a guest search that found something, once per searcher per day', async () => {
    const { service, days, search } = build();
    await service.record('lamp', 3, GUEST_VIEWER, 'ip:1', NOW);
    await service.record('lamp', 3, GUEST_VIEWER, 'ip:1', NOW);
    expect(search.count).not.toHaveBeenCalled();
    expect(days.updateOne).toHaveBeenCalledTimes(1);
    expect(days.updateOne).toHaveBeenCalledWith(
      { _id: '2026-11-13|lamp' },
      {
        $inc: { searchers: 1 },
        $setOnInsert: {
          term: 'lamp',
          day: '2026-11-13',
          expiresAt: new Date('2026-12-14T00:00:00Z'),
        },
      },
      { upsert: true },
    );
  });

  it('checks a member search against what a guest could find', async () => {
    const yes = build([], [], 2);
    await yes.service.record('lamp', 5, MEMBER, 'user:x', NOW);
    expect(yes.search.count).toHaveBeenCalledWith('lamp', GUEST_VIEWER);
    expect(yes.days.updateOne).toHaveBeenCalled();
    const no = build([], [], 0);
    await no.service.record('velvet', 5, MEMBER, 'user:x', NOW);
    expect(no.days.updateOne).not.toHaveBeenCalled();
  });

  it('ignores searches that found nothing or are not fragment-shaped', async () => {
    const { service, days } = build();
    await service.record('lamp', 0, GUEST_VIEWER, 'ip:1', NOW);
    await service.record('a@b.test', 2, GUEST_VIEWER, 'ip:1', NOW);
    expect(days.updateOne).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const { service, days, warn } = build();
    days.updateOne.mockImplementationOnce(() => {
      throw new Error('down');
    });
    await expect(
      service.record('lamp', 1, GUEST_VIEWER, 'ip:1', NOW),
    ).resolves.toBeUndefined();
    days.updateOne.mockImplementationOnce(() => {
      throw 'plain';
    });
    await service.record('lamp', 1, GUEST_VIEWER, 'ip:2', NOW);
    expect(warn).toHaveBeenCalledWith('A search could not be counted: down');
    expect(warn).toHaveBeenCalledWith('A search could not be counted: plain');
  });

  it('uses the configured window', async () => {
    const { service, days } = build([], [], 1, {
      SEARCH_FRAGMENT_WINDOW_DAYS: 7,
    });
    await service.record('lamp', 1, GUEST_VIEWER, 'ip:1', NOW);
    expect((days.updateOne.mock.calls as unknown[][])[0][1]).toEqual(
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          expiresAt: new Date('2026-11-21T00:00:00Z'),
        }),
      }),
    );
  });
});

describe('SearchFragmentsService lists', () => {
  it('shows terms with enough searchers that still match public content, not hidden ones', async () => {
    const { service, days, search } = build(
      [
        { _id: 'lamp', searchers: 9 },
        { _id: 'gone', searchers: 8 },
        { _id: 'hidden word', searchers: 7 },
        { _id: 'a@b', searchers: 6 },
      ],
      ['hidden word', 'old hide'],
    );
    search.count.mockImplementation((term: string) =>
      Promise.resolve(term === 'gone' ? 0 : 1),
    );
    expect(await service.adminView(NOW)).toEqual([
      { term: 'lamp', searchers: 9, hidden: false, shown: true },
      { term: 'gone', searchers: 8, hidden: false, shown: false },
      { term: 'hidden word', searchers: 7, hidden: true, shown: false },
      { term: 'a@b', searchers: 6, hidden: false, shown: false },
      { term: 'old hide', searchers: 0, hidden: true, shown: false },
    ]);
    const pipeline = (days.aggregate.mock.calls as unknown[][])[0][0] as any[];
    expect(pipeline[0]).toEqual({ $match: { day: { $gte: '2026-10-15' } } });
    expect(pipeline[2]).toEqual({ $match: { searchers: { $gte: 5 } } });
  });

  it('caches the public list and checks no more than it can show', async () => {
    const many = Array.from({ length: MAX_FRAGMENTS + 3 }, (_, n) => ({
      _id: `term ${String.fromCharCode(97 + n)}`,
      searchers: 20 - n,
    }));
    const { service, search, days } = build(many);
    const first = await service.fragments(NOW);
    expect(first).toHaveLength(MAX_FRAGMENTS);
    expect(search.count).toHaveBeenCalledTimes(MAX_FRAGMENTS);
    expect(await service.fragments(new Date(NOW.getTime() + 1))).toBe(first);
    await service.fragments(new Date(NOW.getTime() + FRAGMENTS_CACHE_MS));
    expect(days.aggregate).toHaveBeenCalledTimes(2);
  });
});

describe('SearchFragmentsService.setHidden', () => {
  it('stores the decision, logs it and drops the cache', async () => {
    const { service, hides, log, days } = build();
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
    expect(days.aggregate).toHaveBeenCalledTimes(2);
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
    const { service, days } = build();
    await service.record('lamp', 1, GUEST_VIEWER, 'ip:1');
    expect(days.updateOne).toHaveBeenCalled();
    expect(await service.fragments()).toEqual([]);
    expect(await service.adminView()).toEqual([]);
  });
});
