import { ServiceUnavailableException } from '@nestjs/common';
import { Types } from 'mongoose';
import { GUEST_VIEWER } from '../members/profile-access';
import { SEARCH_UNAVAILABLE, SearchService } from './search.service';

const P1 = new Types.ObjectId();
const P2 = new Types.ObjectId();

function build(results: unknown[], engines = ['text', 'regex']) {
  const aggregate = jest.fn(() => {
    const next = results.shift();
    return {
      exec: () =>
        next instanceof Error ? Promise.reject(next) : Promise.resolve(next),
    };
  });
  const engine = {
    engines: jest.fn(() => Promise.resolve(engines)),
    atlasFailed: jest.fn(),
    textIndexMissing: jest.fn(),
  };
  const indexer = {
    ensureFresh: jest.fn(() => Promise.resolve()),
    generation: jest.fn(() => 4),
  };
  const members = {
    searchScope: jest.fn(() =>
      Promise.resolve({ listed: [P1, P2], full: [P1] }),
    ),
  };
  const service = new SearchService(
    { aggregate } as never,
    members as never,
    engine as never,
    indexer as never,
    { get: () => undefined } as never,
  );
  return { service, aggregate, engine, indexer, members };
}

const ROWS = [
  {
    kind: 'member',
    text: 'Lamp Keeper',
    profileId: P1,
    slug: 'lamp',
    displayName: 'Lamp Keeper',
  },
  {
    kind: 'member',
    text: 'Lamp Other',
    profileId: P2,
    slug: 'other',
    displayName: 'Lamp Other',
  },
  {
    kind: 'belief-title',
    text: 'Lamp title',
    profileId: P1,
    tabId: 't1',
    slug: 'lamp',
    displayName: 'Lamp Keeper',
    tabTitle: 'Lamp title',
  },
  {
    kind: 'belief-text',
    text: 'The lamp burns.',
    profileId: P1,
    tabId: 't2',
    slug: 'lamp',
    displayName: 'Lamp Keeper',
    tabTitle: 'Second',
  },
  {
    kind: 'page',
    text: 'A lamp study.',
    pageId: 'research',
    part: 'block:r1',
    pageTitle: 'Research',
  },
];

describe('SearchService', () => {
  it('shapes each kind of result from what the filter let through', async () => {
    const { service, aggregate, indexer } = build([
      [{ total: [{ n: 5 }], rows: ROWS }],
    ]);
    const response = await service.search('lamp', 'all', 1, GUEST_VIEWER);
    expect(indexer.ensureFresh).toHaveBeenCalled();
    expect(response.total).toBe(5);
    expect(response.results.map((r) => r.kind)).toEqual([
      'member',
      'member',
      'belief',
      'belief',
      'page',
    ]);
    expect(response.results[0]).toEqual(
      expect.objectContaining({
        membersOnly: false,
        highlights: [{ start: 0, end: 4 }],
      }),
    );
    expect(response.results[1]).toEqual(
      expect.objectContaining({ membersOnly: true }),
    );
    expect(response.results[2]).toEqual(
      expect.objectContaining({ matched: 'title' }),
    );
    expect(response.results[3]).toEqual(
      expect.objectContaining({ matched: 'text', title: 'Second' }),
    );
    expect(response.results[4]).toEqual(
      expect.objectContaining({
        pageId: 'research',
        title: 'Research',
        part: 'block:r1',
      }),
    );
    const pipeline = (aggregate.mock.calls as unknown[][])[0][0] as object[];
    expect(pipeline[0]).toEqual({ $match: { $text: { $search: 'lamp' } } });
  });

  it("passes on the indexer's write count", () => {
    expect(build([]).service.indexGeneration()).toBe(4);
  });

  it('answers an empty aggregation with nothing', async () => {
    const { service } = build([[]]);
    expect((await service.search('lamp', 'all', 1, GUEST_VIEWER)).total).toBe(
      0,
    );
    const words = build([[{ total: [], rows: [] }]]);
    expect(
      (await words.service.search('lamp', 'all', 1, GUEST_VIEWER)).total,
    ).toBe(0);
  });

  it('counts a phrase in what a guest may see, sharing a scope when given one', async () => {
    const { service, aggregate, members } = build([[{ n: 3 }], []]);
    expect(await service.publicPhraseCount('lamp light')).toBe(3);
    expect(members.searchScope).toHaveBeenCalledWith(GUEST_VIEWER);
    const pipeline = (aggregate.mock.calls as unknown[][])[0][0] as any[];
    expect(pipeline[0]).toEqual({
      $match: {
        kind: { $in: ['belief-text', 'page'] },
        folded: { $regex: ' lamp light ' },
      },
    });
    expect(pipeline.at(-1)).toEqual({ $count: 'n' });
    members.searchScope.mockClear();
    expect(
      await service.publicPhraseCount('lamp', { listed: [], full: [] }),
    ).toBe(0);
    expect(members.searchScope).not.toHaveBeenCalled();
  });

  it('runs nothing for a query with no words', async () => {
    const { service, aggregate } = build([]);
    expect(await service.search('...', 'all', 1, GUEST_VIEWER)).toEqual({
      query: '...',
      type: 'all',
      page: 1,
      pageSize: 10,
      total: 0,
      results: [],
    });
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('moves to the next engine when Atlas fails or the text index is missing', async () => {
    const { service, engine } = build(
      [
        new Error('no $search'),
        Object.assign(new Error('x'), { code: 27 }),
        [],
      ],
      ['atlas', 'text', 'regex'],
    );
    await service.search('lamp', 'all', 1, GUEST_VIEWER);
    expect(engine.atlasFailed).toHaveBeenCalled();
    expect(engine.textIndexMissing).toHaveBeenCalled();
  });

  it('answers 503, never 500, when no engine can', async () => {
    const other = build([new Error('network')]);
    await expect(
      other.service.search('lamp', 'all', 1, GUEST_VIEWER),
    ).rejects.toThrow(new ServiceUnavailableException(SEARCH_UNAVAILABLE));
    const none = build([new Error('atlas')], ['atlas']);
    await expect(
      none.service.search('lamp', 'all', 1, GUEST_VIEWER),
    ).rejects.toThrow(SEARCH_UNAVAILABLE);
  });
});
