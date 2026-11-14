/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/only-throw-error */
import { Types } from 'mongoose';
import {
  FULL_REBUILD_EVERY_MS,
  pageParts,
  REFRESH_EVERY_MS,
  SearchIndexerService,
} from './search-indexer.service';

const chain = (value: unknown) => {
  const query = {
    select: () => query,
    sort: () => query,
    lean: () => query,
    exec: () => Promise.resolve(value),
  };
  return query;
};
const exec = (value: unknown = {}) => ({ exec: () => Promise.resolve(value) });

const P = new Types.ObjectId();

function build(
  overrides: {
    versionsChanged?: string[];
    tabsFromVersions?: unknown[];
    tabsFromBlocks?: unknown[];
    allTabs?: unknown[];
    blocks?: unknown[];
    heads?: unknown[];
    pages?: unknown[];
    site?: string;
  } = {},
) {
  const entries = {
    bulkWrite: jest.fn(() => Promise.resolve({})),
    deleteMany: jest.fn(() => exec()),
  };
  const profiles = {
    find: jest.fn(() => chain([{ _id: P, displayName: 'Synthetic Name' }])),
  };
  const tabs = {
    find: jest.fn(() =>
      chain([{ tabId: 'tab_1', title: 'Synthetic title', profileId: P }]),
    ),
  };
  const blocks = {
    distinct: jest.fn((_field: string, filter: Record<string, unknown>) => {
      if (filter.blockId)
        return Promise.resolve(overrides.tabsFromVersions ?? []);
      if (filter.updatedAt)
        return Promise.resolve(overrides.tabsFromBlocks ?? []);
      return Promise.resolve(overrides.allTabs ?? ['tab_1', null]);
    }),
    find: jest.fn(() =>
      chain(
        overrides.blocks ?? [
          { blockId: 'b1', kind: 'paragraph', profileId: P },
          { blockId: 'b2', kind: 'paragraph', profileId: P },
          { blockId: 'img', kind: 'image', profileId: P },
        ],
      ),
    ),
  };
  const versions = {
    distinct: jest.fn(() => Promise.resolve(overrides.versionsChanged ?? [])),
    aggregate: jest.fn(() =>
      exec(overrides.heads ?? [{ _id: 'b1', seq: 1, text: 'First text.' }]),
    ),
  };
  const pages = {
    find: jest.fn(() =>
      chain(
        overrides.pages ?? [
          {
            pageId: 'research',
            published: {
              revision: 2,
              content: {
                kind: 'reference',
                id: 'research',
                title: 'Research',
                subtitle: '',
                blocks: [{ id: 'r1', kind: 'paragraph', text: 'Body.' }],
              },
            },
          },
        ],
      ),
    ),
  };
  const indexer = new SearchIndexerService(
    entries as never,
    profiles as never,
    tabs as never,
    blocks as never,
    versions as never,
    pages as never,
    {
      get: (key: string) => (key === 'SITE_ENV' ? overrides.site : undefined),
    } as never,
  );
  const warn = jest
    .spyOn((indexer as any).logger, 'warn')
    .mockImplementation(() => undefined);
  return { indexer, entries, profiles, tabs, blocks, versions, pages, warn };
}

const ops = (entries: { bulkWrite: jest.Mock }) =>
  (entries.bulkWrite.mock.calls as unknown as Array<[Array<any>]>).flatMap(
    ([batch]) => batch.map((op) => op.updateOne.filter._id),
  );

describe('pageParts', () => {
  it('reads every text of a reference page and of the About page', () => {
    expect(pageParts(undefined)).toEqual([]);
    expect(
      pageParts({
        kind: 'reference',
        id: 'legal',
        title: 'Legal',
        subtitle: 'Sub',
        blocks: undefined as never,
      }),
    ).toEqual([
      { part: 'title', text: 'Legal' },
      { part: 'subtitle', text: 'Sub' },
    ]);
    expect(
      pageParts({
        kind: 'about',
        id: 'about',
        title: 'About',
        statusNote: '',
        contact: {} as never,
        articles: [
          {
            id: 'a1',
            roman: 'I',
            eyebrow: '',
            lead: 'Lead.',
            body: [
              {
                id: 'n1',
                marker: '1',
                text: 'Node.',
                children: [
                  {
                    id: 'n2',
                    marker: 'a',
                    text: 'Child.',
                    children: undefined as never,
                  },
                ],
              },
            ],
          },
          {
            id: 'a2',
            roman: 'II',
            eyebrow: '',
            lead: '',
            body: undefined as never,
          },
        ],
      }),
    ).toEqual([
      { part: 'title', text: 'About' },
      { part: 'article:a1', text: 'Lead.' },
      { part: 'node:n1', text: 'Node.' },
      { part: 'node:n2', text: 'Child.' },
    ]);
    expect(
      pageParts({
        kind: 'about',
        title: 'About',
        articles: undefined,
      } as never),
    ).toEqual([{ part: 'title', text: 'About' }]);
  });
});

describe('SearchIndexerService', () => {
  it('reads everything on a full refresh', async () => {
    const { indexer, entries, blocks } = build();
    await indexer.refresh({ full: true });
    expect(ops(entries)).toEqual([
      `member:${String(P)}`,
      'title:tab_1',
      'text:b1',
      'page:production:research:title',
      'page:production:research:block:r1',
    ]);
    expect(blocks.distinct).toHaveBeenCalledWith('tabId', {
      section: 'beliefs',
    });
    expect(entries.deleteMany).toHaveBeenCalledWith({
      kind: 'belief-text',
      tabId: 'tab_1',
      blockId: { $nin: ['b1'] },
    });
    expect(entries.deleteMany).toHaveBeenCalledWith({
      kind: 'page',
      pageId: 'research',
      variant: 'production',
      part: { $nin: ['title', 'block:r1'] },
    });
  });

  it('indexes only the block an edit wrote, as the page shows it', async () => {
    const { indexer, entries } = build({
      heads: [
        { _id: 'b1', seq: 2, text: 'Whole edited text.' },
        { _id: 'b2', seq: 1, text: 'Leftover.' },
      ],
    });
    await indexer.refresh({ full: true });
    expect(ops(entries)).toContain('text:b1');
    expect(ops(entries)).not.toContain('text:b2');
  });

  it('reads only what changed since the last refresh', async () => {
    const { indexer, profiles, versions, blocks } = build({
      versionsChanged: ['b1'],
      tabsFromVersions: ['tab_1'],
      tabsFromBlocks: ['tab_1', 'tab_2'],
      pages: [{ pageId: 'legal' }],
    });
    await indexer.refresh({ full: true });
    await indexer.refresh({ full: false });
    const filter = (profiles.find.mock.calls as unknown[][])[1][0] as {
      updatedAt: { $gte: Date };
    };
    expect(filter.updatedAt.$gte).toBeInstanceOf(Date);
    expect(versions.distinct).toHaveBeenCalledWith(
      'blockId',
      expect.objectContaining({ createdAt: expect.any(Object) }),
    );
    expect(blocks.find).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'tab_2' }),
    );
  });

  it('skips the version lookup when no version is new', async () => {
    const { indexer, blocks, entries } = build({ tabsFromBlocks: [] });
    await indexer.refresh({ full: false });
    expect(
      (blocks.distinct.mock.calls as unknown[][]).some(
        ([, filter]) => (filter as { blockId?: unknown }).blockId,
      ),
    ).toBe(false);
    expect(ops(entries)).not.toContain('text:b1');
  });

  it('runs one refresh at a time', async () => {
    const { indexer, profiles } = build();
    await Promise.all([
      indexer.refresh({ full: true }),
      indexer.refresh({ full: true }),
    ]);
    expect(profiles.find).toHaveBeenCalledTimes(1);
  });

  it('refreshes at most every few seconds and fully every few hours', async () => {
    const { indexer, profiles } = build();
    await indexer.ensureFresh(FULL_REBUILD_EVERY_MS);
    // The full rebuild runs in the background: let it finish.
    await new Promise((resolve) => setImmediate(resolve));
    await indexer.ensureFresh(FULL_REBUILD_EVERY_MS + 1);
    expect(profiles.find).toHaveBeenCalledTimes(1);
    expect(profiles.find).toHaveBeenLastCalledWith({});
    await indexer.ensureFresh(FULL_REBUILD_EVERY_MS + REFRESH_EVERY_MS);
    expect(profiles.find).toHaveBeenCalledTimes(2);
    expect(profiles.find).toHaveBeenLastCalledWith(
      expect.objectContaining({ updatedAt: expect.any(Object) }),
    );
  });

  it('logs a failed refresh and lets search go on', async () => {
    const { indexer, profiles, warn } = build();
    profiles.find.mockImplementationOnce(() => {
      throw new Error('down');
    });
    await expect(
      indexer.ensureFresh(REFRESH_EVERY_MS),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Search refresh failed: down');
    profiles.find.mockImplementationOnce(() => {
      throw 'plain';
    });
    await indexer.ensureFresh(3 * REFRESH_EVERY_MS);
    expect(warn).toHaveBeenCalledWith('Search refresh failed: plain');
  });

  it('starts a refresh with the server', () => {
    const { indexer } = build();
    const fresh = jest.spyOn(indexer, 'ensureFresh').mockResolvedValue();
    indexer.onApplicationBootstrap();
    expect(fresh).toHaveBeenCalled();
  });

  it('writes nothing when nothing changed', async () => {
    const { indexer, entries, profiles, tabs } = build({
      allTabs: [],
      pages: [],
    });
    profiles.find.mockReturnValue(chain([]));
    tabs.find.mockReturnValue(chain([]));
    await indexer.refresh({ full: true });
    expect(entries.bulkWrite).not.toHaveBeenCalled();
  });
});

describe('SearchIndexerService defaults', () => {
  it('uses the current time, and skips a block with no version', async () => {
    const { indexer, entries } = build({ heads: [] });
    await indexer.ensureFresh();
    expect(ops(entries)).not.toContain('text:b1');
  });
});

describe('SearchIndexerService full rebuild, review L5', () => {
  it('never makes a reader wait for a full rebuild', async () => {
    const { indexer, profiles } = build();
    profiles.find.mockReturnValue({
      select: () => ({
        lean: () => ({ exec: () => new Promise(() => undefined) }),
      }),
    } as never);
    const outcome = await Promise.race([
      indexer.ensureFresh(FULL_REBUILD_EVERY_MS).then(() => 'returned'),
      new Promise((resolve) => setTimeout(() => resolve('waited'), 200)),
    ]);
    expect(outcome).toBe('returned');
    // Nor behind it later: a refresh already running is not joined.
    await indexer.ensureFresh(FULL_REBUILD_EVERY_MS + 2 * REFRESH_EVERY_MS);
    expect(profiles.find).toHaveBeenCalledTimes(1);
  });
});

describe('SearchIndexerService copies, review L1 and M2', () => {
  const setOf = (entries: { bulkWrite: jest.Mock }) =>
    (entries.bulkWrite.mock.calls as unknown as Array<[Array<any>]>).flatMap(
      ([batch]) => batch.map((op) => op.updateOne.update.$set),
    );

  it('stores a folded copy of every text', async () => {
    const { indexer, entries } = build();
    await indexer.refresh({ full: true });
    expect(setOf(entries)[0]).toEqual(
      expect.objectContaining({
        text: 'Synthetic Name',
        folded: ' synthetic name ',
      }),
    );
  });

  it('indexes the test site pages as the test site serves them', async () => {
    const page = {
      pageId: 'donations',
      published: {
        revision: 3,
        content: {
          kind: 'reference',
          id: 'donations',
          title: 'Gifts',
          subtitle: '',
          blocks: [{ id: 'd1', kind: 'paragraph', text: 'Pay $synthorg now.' }],
        },
      },
    };
    const test = build({ pages: [page], site: 'test' });
    await test.indexer.refresh({ full: true });
    const pages = setOf(test.entries).filter((set) => set.kind === 'page');
    expect(pages.map((set) => [set.variant, set.revision])).toEqual([
      ['test', 3],
      ['test', 3],
    ]);
    expect(JSON.stringify(pages)).not.toContain('synthorg');
    const live = build({ pages: [page] });
    await live.indexer.refresh({ full: true });
    const livePages = setOf(live.entries).filter((set) => set.kind === 'page');
    expect(livePages[0].variant).toBe('production');
    expect(JSON.stringify(livePages)).toContain('synthorg');
  });
});

describe('SearchIndexerService page ids, round-2 review L3', () => {
  it('keeps each site its own page entries', async () => {
    const test = build({ site: 'test' });
    await test.indexer.refresh({ full: true });
    expect(ops(test.entries)).toContain('page:test:research:title');
    expect(test.entries.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'page', variant: 'test' }),
    );
    const live = build();
    await live.indexer.refresh({ full: true });
    expect(ops(live.entries)).toContain('page:production:research:title');
  });

  it('counts each change to the index (round-2 review L2)', async () => {
    const { indexer } = build();
    const before = indexer.generation();
    await indexer.refresh({ full: true });
    expect(indexer.generation()).toBeGreaterThan(before);
  });
});

describe('SearchIndexerService generation, round-3 review', () => {
  it('counts a refresh that only deletes entries as a change', async () => {
    const { indexer, entries, profiles, tabs } = build({
      pages: [],
      blocks: [],
    });
    profiles.find.mockReturnValue(chain([]));
    tabs.find.mockReturnValue(chain([]));
    entries.deleteMany.mockReturnValue(exec({ deletedCount: 1 }));
    await indexer.refresh({ full: true });
    expect(entries.bulkWrite).not.toHaveBeenCalled();
    expect(indexer.generation()).toBeGreaterThan(0);
  });

  it('does not count a delete that removed nothing', async () => {
    const { indexer, profiles, tabs } = build({ pages: [], blocks: [] });
    profiles.find.mockReturnValue(chain([]));
    tabs.find.mockReturnValue(chain([]));
    await indexer.refresh({ full: true });
    expect(indexer.generation()).toBe(0);
  });
});
