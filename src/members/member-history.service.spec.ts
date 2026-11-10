/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
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
    skip: jest.fn(() => query),
    limit: jest.fn(() => query),
    lean: jest.fn(() => query),
    exec: jest.fn(() => Promise.resolve(value)),
  };
  return query;
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

/** A bio imported as two paragraphs, then edited once by its owner. */
const BIO_VERSIONS = [
  {
    blockId: 'b-1',
    seq: 2,
    text: 'Edited whole bio.',
    createdAt: at(30),
    hash: hash('a'),
    authorUserId: 'user_owner',
    prevHash: hash('0'),
    _id: 'v-internal',
  },
  {
    blockId: 'b-2',
    seq: 1,
    text: 'Second imported paragraph.',
    createdAt: at(1),
    hash: hash('b'),
    authorUserId: IMPORT_AUTHOR,
  },
  {
    blockId: 'b-1',
    seq: 1,
    text: 'First imported paragraph.',
    createdAt: at(0),
    hash: hash('c'),
    authorUserId: IMPORT_AUTHOR,
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
    versions?: unknown[];
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
    find: jest.fn(() =>
      chain(options.blocks ?? [{ blockId: 'b-1' }, { blockId: 'b-2' }]),
    ),
  };
  const versionQuery = chain(options.versions ?? BIO_VERSIONS);
  const versionModel = { find: jest.fn(() => versionQuery) };
  const members = new MembersService(
    profileModel as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const service = new MemberHistoryService(
    members,
    tabModel as never,
    blockModel as never,
    versionModel as never,
  );
  return { service, tabModel, blockModel, versionModel, versionQuery };
}

describe('history entries', () => {
  it('lists newest first with server time, text, a short hash and where it came from', async () => {
    const { service, versionModel, versionQuery } = setup();
    const result = await service.bioHistory('quiet-fern', GUEST_VIEWER);
    expect(result).toEqual({
      page: 1,
      hasMore: false,
      entries: [
        {
          seq: 2,
          savedAt: '2026-11-01T12:30:00.000Z',
          text: 'Edited whole bio.',
          hash: 'aaaaaaaaaaaa',
          source: 'member',
          wholeText: true,
        },
        {
          seq: 1,
          savedAt: '2026-11-01T12:01:00.000Z',
          text: 'Second imported paragraph.',
          hash: 'bbbbbbbbbbbb',
          source: 'imported',
          wholeText: false,
        },
        {
          seq: 1,
          savedAt: '2026-11-01T12:00:00.000Z',
          text: 'First imported paragraph.',
          hash: 'cccccccccccc',
          source: 'imported',
          wholeText: false,
        },
      ],
    });
    expect(versionModel.find).toHaveBeenCalledWith({
      blockId: { $in: ['b-1', 'b-2'] },
    });
    expect(versionQuery.sort).toHaveBeenCalledWith({ createdAt: -1, seq: -1 });
  });

  it('never sends an author id, a database id, a full hash or the page source fields', async () => {
    const { service } = setup();
    const text = JSON.stringify(await service.bioHistory('quiet-fern', owner));
    for (const secret of [
      'user_owner',
      'v-internal',
      'prevHash',
      hash('a'),
      'secret-lookalike',
      'legacy.example',
      'authorUserId',
      'blockId',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('pages twenty at a time, asking for one more to know if there is a next page', async () => {
    const many = Array.from({ length: HISTORY_PAGE_SIZE + 1 }, (_, i) => ({
      ...BIO_VERSIONS[0],
      seq: 30 - i,
    }));
    const { service, versionQuery } = setup({ versions: many });
    const result = await service.bioHistory('quiet-fern', owner, 3);
    expect(result.entries).toHaveLength(HISTORY_PAGE_SIZE);
    expect(result).toMatchObject({ page: 3, hasMore: true });
    expect(versionQuery.skip).toHaveBeenCalledWith(2 * HISTORY_PAGE_SIZE);
    expect(versionQuery.limit).toHaveBeenCalledWith(HISTORY_PAGE_SIZE + 1);
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
      wholeText: true,
    });
    expect(versionModel.find).toHaveBeenCalledWith({
      blockId: { $in: ['ttl_tab_a'] },
    });
    expect(blockModel.find).not.toHaveBeenCalled();
  });

  it('reads a belief’s text from all its text blocks, removed ones too', async () => {
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
