/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { IMPORT_AUTHOR } from '../import/pages/import-plan';
import { TITLE_RECORD_AUTHOR } from './editable-fields';
import {
  HISTORY_PAGE_SIZE,
  MemberHistoryService,
} from './member-history.service';
import { MembersService, PROFILE_NOT_FOUND } from './members.service';
import { GUEST_VIEWER, type Viewer } from './profile-access';

const profileId = new Types.ObjectId();

function chain(value: unknown) {
  const query = {
    select: jest.fn(() => query),
    sort: jest.fn(() => query),
    lean: jest.fn(() => query),
    exec: jest.fn(() => Promise.resolve(value)),
  };
  return query;
}

interface Row {
  _id: string;
  blockId: string;
  seq: number;
  text: string;
  createdAt: Date;
  hash: string;
  authorUserId: string;
  prevHash?: string;
  suggestionId?: string;
  suggestedBy?: string;
}

/**
 * A small version store that honours the filters, the sort, skip and limit
 * the service sends, so pagination is tested against real ordering rules.
 */
function versionStore(rows: Row[]) {
  const matches = (row: Row, filter: Record<string, any>) => {
    const ids = filter.blockId?.$in ?? [filter.blockId];
    if (!ids.includes(row.blockId)) return false;
    if (typeof filter.seq === 'number') return row.seq === filter.seq;
    if (filter.seq?.$gt !== undefined) return row.seq > filter.seq.$gt;
    return true;
  };
  const queries: any[] = [];
  const model = {
    countDocuments: jest.fn((filter: Record<string, any>) => ({
      exec: () =>
        Promise.resolve(rows.filter((row) => matches(row, filter)).length),
    })),
    find: jest.fn((filter: Record<string, any>) => {
      const state = { sort: undefined as any, skip: 0, limit: Infinity };
      const query = {
        sort: jest.fn((sort: any) => ((state.sort = sort), query)),
        skip: jest.fn((n: number) => ((state.skip = n), query)),
        limit: jest.fn((n: number) => ((state.limit = n), query)),
        select: jest.fn(() => query),
        lean: jest.fn(() => query),
        exec: () => {
          let out = rows.filter((row) => matches(row, filter));
          // The sort keys in order; ties left over are broken differently
          // on every query, as a database without a unique key may do.
          const salt = queries.length;
          const scramble = (id: string) =>
            [...id].reduce(
              (h, c) => (h * 31 + c.charCodeAt(0) + salt) % 9973,
              7,
            );
          out = [...out].sort((x: any, y: any) => {
            for (const [key, direction] of Object.entries(state.sort ?? {})) {
              const left = x[key] instanceof Date ? x[key].getTime() : x[key];
              const right = y[key] instanceof Date ? y[key].getTime() : y[key];
              if (left !== right) {
                return (left < right ? -1 : 1) * (direction as number);
              }
            }
            return scramble(x._id) - scramble(y._id);
          });
          return Promise.resolve(
            out.slice(state.skip, state.skip + state.limit),
          );
        },
      };
      queries.push(query);
      return query;
    }),
  };
  return { model, queries };
}

const FORBIDDEN = {
  similarNameOf: ['secret-lookalike'],
  legacy: { pagesUrl: 'https://legacy.example/secret-doc' },
};

function page(overrides: Record<string, unknown> = {}) {
  return {
    _id: profileId,
    slug: 'quiet-fern',
    displayName: 'Quiet Fern',
    visibility: 'public',
    reviewStatus: 'approved',
    ownerUserId: 'user_owner',
    ...FORBIDDEN,
    ...overrides,
  };
}

const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 12, minute));
const hash = (c: string) => c.repeat(64);

/** A bio imported as three paragraphs (I., unlabelled, A.), then edited twice. */
const BIO_BLOCKS = [
  { blockId: 'b-1', label: 'I.' },
  { blockId: 'b-2', label: '' },
  { blockId: 'b-3', label: 'A.' },
];
const imported = (blockId: string, text: string, c: string): Row => ({
  _id: `v-${blockId}-1`,
  blockId,
  seq: 1,
  text,
  createdAt: at(0),
  hash: hash(c),
  authorUserId: IMPORT_AUTHOR,
});
const BIO_VERSIONS: Row[] = [
  // Stored in an order unlike the page, as a database may return them.
  imported('b-3', 'Third.', 'c'),
  imported('b-1', 'First.', 'a'),
  imported('b-2', 'Second.', 'b'),
  {
    _id: 'v-b-1-2',
    blockId: 'b-1',
    seq: 2,
    text: 'Edited whole bio.',
    createdAt: at(30),
    hash: hash('d'),
    authorUserId: 'user_owner',
    prevHash: hash('a'),
  },
  {
    _id: 'v-b-1-3',
    blockId: 'b-1',
    seq: 3,
    text: 'Edited again.',
    createdAt: at(30),
    hash: hash('e'),
    authorUserId: 'user_owner',
  },
];

const owner: Viewer = {
  kind: 'signed-in',
  userId: 'user_owner',
  isAdmin: false,
};
const admin: Viewer = { kind: 'signed-in', userId: 'user_x', isAdmin: true };
const named: Viewer = {
  kind: 'named-member',
  userId: 'user_n',
  isAdmin: false,
};
const anonymous: Viewer = {
  kind: 'anonymous-member',
  userId: 'user_a',
  isAdmin: false,
};

function setup(
  options: {
    profile?: unknown;
    tab?: unknown;
    blocks?: unknown[];
    versions?: Row[];
    adminSuggestions?: Array<{ commentId: string }>;
  } = {},
) {
  const profileModel = {
    findOne: jest.fn(() =>
      chain(options.profile === undefined ? page() : options.profile),
    ),
  };
  const tabModel = {
    findOne: jest.fn(() =>
      chain(options.tab === undefined ? { tabId: 'tab_a' } : options.tab),
    ),
  };
  const blockModel = {
    find: jest.fn(() => chain(options.blocks ?? BIO_BLOCKS)),
  };
  const store = versionStore(options.versions ?? BIO_VERSIONS);
  const members = new MembersService(
    profileModel as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const authors = {
    // Who may get hash prefixes (Chunk 16 round 2): everyone, here; the
    // refusals are tested over the real services (receipts.review2.spec).
    identifiable: jest.fn(() => Promise.resolve(() => true)),
    resolve: jest.fn(() =>
      Promise.resolve((userId: string) => ({
        kind: 'member' as const,
        displayName: `Name of ${userId}`,
      })),
    ),
  };
  const service = new MemberHistoryService(
    members,
    tabModel as never,
    blockModel as never,
    store.model as never,
    authors as never,
    {
      find: jest.fn(() => ({
        select: () => ({
          lean: () => ({
            exec: () => Promise.resolve(options.adminSuggestions ?? []),
          }),
        }),
      })),
    } as never,
  );
  return {
    service,
    tabModel,
    blockModel,
    versionModel: store.model,
    queries: store.queries,
  };
}

describe('history entries', () => {
  it('lists edits newest first, then the earlier text as ONE entry in reading order with its labels', async () => {
    const { service } = setup();
    const result = await service.bioHistory('quiet-fern', GUEST_VIEWER);
    expect(result).toEqual({
      page: 1,
      hasMore: false,
      entries: [
        {
          seq: 3,
          savedAt: '2026-11-01T12:30:00.000Z',
          text: 'Edited again.',
          hash: 'eeeeeeeeeeee',
          source: 'member',
          beforeFirstEdit: false,
        },
        {
          seq: 2,
          savedAt: '2026-11-01T12:30:00.000Z',
          text: 'Edited whole bio.',
          hash: 'dddddddddddd',
          source: 'member',
          beforeFirstEdit: false,
        },
        {
          seq: 1,
          savedAt: '2026-11-01T12:00:00.000Z',
          text: 'I. First.\n\nSecond.\n\nA. Third.',
          hash: 'aaaaaaaaaaaa',
          source: 'imported',
          beforeFirstEdit: true,
          partHashes: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'],
        },
      ],
    });
  });

  it('sorts by version number with the database id as the last tie-breaker', async () => {
    const { service, queries } = setup();
    await service.bioHistory('quiet-fern', owner);
    expect(queries[0].sort).toHaveBeenCalledWith({ seq: -1, _id: -1 });
  });

  it('shows a never-edited text of several paragraphs as one current entry', async () => {
    const { service } = setup({ versions: BIO_VERSIONS.slice(0, 3) });
    const result = await service.bioHistory('quiet-fern', owner);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      beforeFirstEdit: false,
      text: 'I. First.\n\nSecond.\n\nA. Third.',
      source: 'imported',
    });
  });

  it('marks the earlier text as the member’s when none of it was imported', async () => {
    const own = BIO_VERSIONS.map((row) => ({
      ...row,
      authorUserId: 'user_owner',
    }));
    const { service } = setup({ versions: own });
    const result = await service.bioHistory('quiet-fern', owner);
    expect(result.entries.at(-1)).toMatchObject({ source: 'member' });
  });

  it('leaves out the earlier text when none of its versions can be read', async () => {
    const { service } = setup({ versions: BIO_VERSIONS.slice(3) });
    const result = await service.bioHistory('quiet-fern', owner);
    expect(result.entries.map((entry) => entry.seq)).toEqual([3, 2]);
  });

  it('never sends an author id, a database id, a full hash or the page source fields', async () => {
    const { service } = setup();
    const text = JSON.stringify(await service.bioHistory('quiet-fern', owner));
    for (const secret of [
      'user_owner',
      'v-b-1',
      'prevHash',
      hash('a'),
      'secret-lookalike',
      'legacy.example',
      'authorUserId',
      'blockId',
      '_id',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  describe('paging', () => {
    /** 45 edits with the same time, the case where a time sort is unstable. */
    const tied: Row[] = [
      ...BIO_VERSIONS.slice(0, 3),
      ...Array.from({ length: 45 }, (_, i) => ({
        _id: `e${String(i).padStart(3, '0')}`,
        blockId: 'b-1',
        seq: i + 2,
        text: `Edit ${i + 2}`,
        createdAt: at(10),
        hash: hash('f'),
        authorUserId: 'user_owner',
      })),
    ];

    it('covers every version exactly once, the earlier text last', async () => {
      const seen: string[] = [];
      const pages: boolean[] = [];
      for (let number = 1; number <= 3; number++) {
        const { service } = setup({ versions: tied });
        const result = await service.bioHistory('quiet-fern', owner, number);
        seen.push(...result.entries.map((entry) => entry.text));
        pages.push(result.hasMore);
      }
      expect(seen).toHaveLength(46);
      expect(new Set(seen).size).toBe(46);
      expect(seen.at(0)).toBe('Edit 46');
      expect(seen.at(-1)).toBe('I. First.\n\nSecond.\n\nA. Third.');
      expect(pages).toEqual([true, true, false]);
    });

    it('puts the earlier text on the next page when the edits fill a page exactly', async () => {
      const twenty = tied.slice(0, 3 + HISTORY_PAGE_SIZE);
      const first = await setup({ versions: twenty }).service.bioHistory(
        'quiet-fern',
        owner,
        1,
      );
      expect(first.entries).toHaveLength(HISTORY_PAGE_SIZE);
      expect(first.hasMore).toBe(true);
      const second = await setup({ versions: twenty }).service.bioHistory(
        'quiet-fern',
        owner,
        2,
      );
      expect(second.entries.map((entry) => entry.beforeFirstEdit)).toEqual([
        true,
      ]);
      expect(second.hasMore).toBe(false);
      const beyond = await setup({ versions: twenty }).service.bioHistory(
        'quiet-fern',
        owner,
        3,
      );
      expect(beyond.entries).toEqual([]);
    });

    it('pages a one-block field by asking for one more than a page', async () => {
      const single = Array.from({ length: HISTORY_PAGE_SIZE + 5 }, (_, i) => ({
        _id: `s${String(i).padStart(3, '0')}`,
        blockId: 'b-1',
        seq: i + 1,
        text: `Version ${i + 1}`,
        createdAt: at(1),
        hash: hash('9'),
        authorUserId: 'user_owner',
      }));
      const blocks = [{ blockId: 'b-1' }];
      const one = await setup({ versions: single, blocks }).service.bioHistory(
        'quiet-fern',
        owner,
        1,
      );
      expect(one).toMatchObject({ hasMore: true });
      expect(one.entries).toHaveLength(HISTORY_PAGE_SIZE);
      expect(one.entries[0].text).toBe(`Version ${HISTORY_PAGE_SIZE + 5}`);
      const two = await setup({ versions: single, blocks }).service.bioHistory(
        'quiet-fern',
        owner,
        2,
      );
      expect(two).toMatchObject({ hasMore: false });
      expect(two.entries.map((entry) => entry.seq)).toEqual([5, 4, 3, 2, 1]);
      expect(two.entries.every((entry) => !entry.beforeFirstEdit)).toBe(true);
    });
  });

  it('puts a lone block’s outline label in front of its first version only', async () => {
    const { service } = setup({
      blocks: [{ blockId: 'b-1', label: 'A.' }],
      versions: [
        { ...BIO_VERSIONS[1], text: 'Imported.' },
        { ...BIO_VERSIONS[3], text: 'A. Edited.' },
      ],
    });
    const result = await service.bioHistory('quiet-fern', owner);
    expect(result.entries.map((entry) => entry.text)).toEqual([
      'A. Edited.',
      'A. Imported.',
    ]);
  });

  it('names the member whose suggestion a version came from (Chunk 9)', async () => {
    const { service } = setup({
      blocks: [{ blockId: 'b-1' }],
      versions: [
        { ...BIO_VERSIONS[1], text: 'Imported.' },
        {
          ...BIO_VERSIONS[3],
          text: 'Suggested.',
          suggestionId: 'cmt_s',
          suggestedBy: 'user_s',
        },
        // A malformed row with no author still names someone, not nothing.
        {
          ...BIO_VERSIONS[4],
          seq: 3,
          text: 'Odd.',
          suggestionId: 'cmt_t',
        },
      ],
    });
    const result = await service.bioHistory('quiet-fern', owner);
    expect(result.entries.map((entry) => entry.fromSuggestion)).toEqual([
      {
        commentId: 'cmt_t',
        author: { kind: 'member', displayName: 'Name of ' },
      },
      {
        commentId: 'cmt_s',
        author: { kind: 'member', displayName: 'Name of user_s' },
      },
      undefined,
    ]);
  });

  it('reads no versions for a field with no blocks', async () => {
    const { service, versionModel } = setup({ blocks: [] });
    await expect(service.bioHistory('quiet-fern', owner)).resolves.toEqual({
      entries: [],
      page: 1,
      hasMore: false,
    });
    expect(versionModel.find).not.toHaveBeenCalled();
  });

  it('reads a title history from its own block and marks the recorded first title', async () => {
    const { service, versionModel, blockModel } = setup({
      versions: [
        {
          _id: 't1',
          blockId: 'ttl_tab_a',
          seq: 1,
          text: 'Old',
          createdAt: at(5),
          hash: hash('d'),
          authorUserId: TITLE_RECORD_AUTHOR,
        },
      ],
    });
    const result = await service.tabHistory(
      'quiet-fern',
      'tab_a',
      owner,
      'title',
    );
    expect(result.entries[0]).toMatchObject({
      source: 'title-before-history',
      beforeFirstEdit: false,
    });
    expect(versionModel.find).toHaveBeenCalledWith({ blockId: 'ttl_tab_a' });
    expect(blockModel.find).not.toHaveBeenCalled();
  });

  it('reads a belief’s text from all its text blocks, removed ones too, in reading order', async () => {
    const { service, blockModel } = setup();
    await service.tabHistory('quiet-fern', 'tab_a', owner);
    expect(blockModel.find).toHaveBeenCalledWith({
      profileId,
      section: 'beliefs',
      tabId: 'tab_a',
      kind: { $ne: 'image' },
    });
  });
});

describe('who can read a history', () => {
  it.each([
    ['public', GUEST_VIEWER],
    ['members', anonymous],
    ['named-members', named],
    ['unlisted', owner],
    ['unlisted', admin],
  ])(
    'a %s page: readable by those who see the page',
    async (visibility, viewer) => {
      const { service } = setup({ profile: page({ visibility }) });
      await expect(
        service.bioHistory('quiet-fern', viewer),
      ).resolves.toMatchObject({ page: 1 });
      await expect(
        service.tabHistory('quiet-fern', 'tab_a', viewer),
      ).resolves.toMatchObject({ page: 1 });
    },
  );

  it.each([
    ['members', GUEST_VIEWER],
    ['named-members', anonymous],
    ['unlisted', GUEST_VIEWER],
    ['unlisted', named],
  ])(
    'a %s page: everyone else gets the 404 of a missing page and no version is read',
    async (visibility, viewer) => {
      const { service, versionModel } = setup({
        profile: page({ visibility }),
      });
      await expect(service.bioHistory('quiet-fern', viewer)).rejects.toThrow(
        PROFILE_NOT_FOUND,
      );
      await expect(
        service.tabHistory('quiet-fern', 'tab_a', viewer, 'title'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(versionModel.find).not.toHaveBeenCalled();
    },
  );

  it('a pending page: owner and admins only', async () => {
    for (const viewer of [owner, admin]) {
      const { service } = setup({ profile: page({ reviewStatus: 'pending' }) });
      await expect(
        service.bioHistory('quiet-fern', viewer),
      ).resolves.toBeDefined();
    }
    const { service } = setup({ profile: page({ reviewStatus: 'pending' }) });
    await expect(service.bioHistory('quiet-fern', named)).rejects.toThrow(
      PROFILE_NOT_FOUND,
    );
  });

  it('a deleted or missing page: nobody', async () => {
    for (const profile of [page({ deletedAt: new Date(0) }), null]) {
      const { service } = setup({ profile });
      await expect(service.bioHistory('quiet-fern', admin)).rejects.toThrow(
        PROFILE_NOT_FOUND,
      );
    }
  });

  it('a removed belief: owner and admins only', async () => {
    const removed = { tabId: 'tab_a', removedAt: new Date(0) };
    for (const viewer of [owner, admin]) {
      const { service } = setup({ tab: removed });
      await expect(
        service.tabHistory('quiet-fern', 'tab_a', viewer),
      ).resolves.toBeDefined();
    }
    for (const viewer of [GUEST_VIEWER, named]) {
      const { service, versionModel } = setup({ tab: removed });
      await expect(
        service.tabHistory('quiet-fern', 'tab_a', viewer),
      ).rejects.toThrow(PROFILE_NOT_FOUND);
      expect(versionModel.find).not.toHaveBeenCalled();
    }
  });

  it('a tab on another page, or none, is the same 404', async () => {
    const { service, tabModel } = setup({ tab: null });
    await expect(
      service.tabHistory('quiet-fern', 'tab_other', admin),
    ).rejects.toThrow(PROFILE_NOT_FOUND);
    expect(tabModel.findOne).toHaveBeenCalledWith({
      profileId,
      tabId: 'tab_other',
    });
  });
});
