/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Types } from 'mongoose';
import { MembersService } from './members.service';
import { GUEST_VIEWER, type Viewer } from './profile-access';
import { fullProfile } from './profile-serializers';

/** What the owner's editor and the removed-belief list add to a page (Chunk 8). */

function chain(value: unknown) {
  const query = {
    select: jest.fn(() => query),
    sort: jest.fn(() => query),
    limit: jest.fn(() => query),
    lean: jest.fn(() => query),
    exec: jest.fn(() => Promise.resolve(value)),
  };
  return query;
}

const profileId = new Types.ObjectId();
const v = (n: number) => new Types.ObjectId(String(n).padStart(24, 'b'));

function page() {
  return {
    _id: profileId,
    slug: 'quiet-fern',
    displayName: 'Quiet Fern',
    visibility: 'public',
    reviewStatus: 'approved',
    ownerUserId: 'user_owner',
    imageIds: [],
    contacts: [],
  };
}

const BLOCKS = [
  {
    blockId: 'b-bio',
    section: 'bio',
    kind: 'paragraph',
    currentVersionId: v(1),
  },
  {
    blockId: 'b-1',
    section: 'beliefs',
    kind: 'paragraph',
    tabId: 'tab-1',
    currentVersionId: v(2),
  },
];
const VERSIONS = [
  { _id: v(1), text: 'Synthetic bio' },
  { _id: v(2), text: 'Synthetic belief' },
];
const TABS = [
  { tabId: 'tab-1', title: 'One', reviewStatus: 'confirmed' },
  { tabId: 'tab-2', title: 'Two', reviewStatus: 'confirmed' },
];
const REMOVED_TABS = [
  {
    tabId: 'tab-gone',
    title: 'Gone',
    removedAt: new Date('2026-11-01T10:00:00Z'),
    ownerUserId: 'LEAKED-OWNER',
  },
];
/** Newest version per block; tab-2 has no text block and no title history. */
const HEADS = [
  { _id: 'b-bio', seq: 4 },
  { _id: 'b-1', seq: 2 },
  { _id: 'ttl_tab-1', seq: 3 },
];

const member: Viewer = {
  kind: 'named-member',
  userId: 'user_m',
  isAdmin: false,
};
const owner: Viewer = {
  kind: 'signed-in',
  userId: 'user_owner',
  isAdmin: false,
};
const admin: Viewer = { kind: 'signed-in', userId: 'user_x', isAdmin: true };

/** Each block's newest version, as `readHeads` returns it, from the fixtures. */
function textHeads(
  blocks: ReadonlyArray<{
    blockId: string;
    currentVersionId?: unknown;
    currentVersionSeq?: number;
  }>,
  versions: ReadonlyArray<{ _id: unknown; text: string }>,
) {
  return blocks.flatMap((block) => {
    const head = versions.find(
      (row) => String(row._id) === String(block.currentVersionId),
    );
    return head
      ? [
          {
            _id: block.blockId,
            seq: block.currentVersionSeq ?? 1,
            text: head.text,
          },
        ]
      : [];
  });
}

/** Revisions ask for the highest seq; the page text asks for the newest rows. */
function versionAggregate(pipeline: unknown) {
  return {
    exec: () =>
      Promise.resolve(
        JSON.stringify(pipeline).includes('$max')
          ? HEADS
          : textHeads(BLOCKS, VERSIONS),
      ),
  };
}

function setup(options: { one?: unknown } = {}) {
  const profileModel = { findOne: jest.fn(() => chain(options.one ?? null)) };
  const tabModel = {
    find: jest.fn((filter: { removedAt?: { $exists: boolean } }) =>
      chain(filter.removedAt?.$exists ? REMOVED_TABS : TABS),
    ),
  };
  const blockModel = { find: jest.fn(() => chain(BLOCKS)) };
  const versionModel = {
    aggregate: jest.fn(versionAggregate),
  };
  const pictures = {
    currentPicture: jest.fn(() => Promise.resolve(undefined)),
  };
  const service = new MembersService(
    profileModel as never,
    tabModel as never,
    blockModel as never,
    versionModel as never,
    {
      find: jest.fn(() => chain([])),
      aggregate: jest.fn(() => ({ exec: () => Promise.resolve([]) })),
    } as never,
    pictures as never,
    {} as never,
    {} as never,
  );
  return { service, tabModel, blockModel, versionModel };
}

describe('MembersService.profile, editing data', () => {
  it('gives only the owner the newest version of every editable field', async () => {
    const { service, versionModel } = setup({ one: page() });
    const view = await service.profile('quiet-fern', owner);
    expect(view).toMatchObject({
      revisions: {
        bio: 4,
        tabs: {
          'tab-1': { text: 2, title: 3 },
          'tab-2': { text: 0, title: 0 },
        },
      },
    });
    // Counted from the versions themselves: the bio's first text block, each
    // tab's first text block and each title history.
    expect(versionModel.aggregate).toHaveBeenCalledWith([
      {
        $match: {
          blockId: { $in: ['b-bio', 'b-1', 'ttl_tab-1', 'ttl_tab-2'] },
        },
      },
      { $group: { _id: '$blockId', seq: { $max: '$seq' } } },
    ]);
    for (const viewer of [admin, member, GUEST_VIEWER]) {
      const other = setup({ one: page() });
      const seen = await other.service.profile('quiet-fern', viewer);
      expect(seen).not.toHaveProperty('revisions');
      // Not even read for anyone else.
      expect(other.versionModel.aggregate).not.toHaveBeenCalledWith(
        expect.arrayContaining([
          { $group: { _id: '$blockId', seq: { $max: '$seq' } } },
        ]),
      );
    }
  });

  it('the serialiser drops editor and removed-tab data for anyone else, whatever it is given', () => {
    const view = fullProfile(
      page() as never,
      { level: 'full', listed: true, isOwner: false },
      false,
      true,
      {
        bio: [],
        extras: [],
        tabs: [],
        pageCommentCount: 0,
        revisions: { bio: 3, tabs: {} },
        removedTabs: [{ tabId: 't', title: 'Gone', removedAt: 'x' }],
      },
      undefined,
      false,
    );
    expect(view).not.toHaveProperty('revisions');
    expect(view).not.toHaveProperty('manage');
    expect(JSON.stringify(view)).not.toContain('Gone');
  });

  it('the serialiser gives an admin the settings but never the editor’s versions', () => {
    const view = fullProfile(
      page() as never,
      { level: 'full', listed: true, isOwner: false },
      true,
      true,
      {
        bio: [],
        extras: [],
        tabs: [],
        pageCommentCount: 0,
        revisions: { bio: 3, tabs: {} },
        removedTabs: [],
      },
      undefined,
      false,
    );
    expect(view).toHaveProperty('manage');
    expect(view).not.toHaveProperty('revisions');
  });

  it('shows a block’s newest version, even when its pointer was left behind', async () => {
    // The bio block's pointer still names v(1); a newer version exists.
    const { service, versionModel } = setup({ one: page() });
    versionModel.aggregate.mockReturnValueOnce({
      exec: () =>
        // Version 2 exists; the pointer was left at version 1.
        Promise.resolve([{ _id: 'b-bio', seq: 2, text: 'Newest bio' }]),
    });
    const view = await service.profile('quiet-fern', GUEST_VIEWER);
    expect(view).toMatchObject({ bio: [{ text: 'Newest bio' }] });
  });

  it('shows only the first block of a field once it holds an edit, as a plain paragraph', async () => {
    const { service, blockModel, versionModel } = setup({ one: page() });
    blockModel.find.mockReturnValueOnce(
      chain([
        {
          blockId: 'b-1',
          section: 'beliefs',
          kind: 'outline-item',
          label: 'I.',
          tabId: 'tab-1',
          currentVersionId: v(1),
          currentVersionSeq: 2,
        },
        {
          blockId: 'b-2',
          section: 'beliefs',
          kind: 'paragraph',
          label: '',
          tabId: 'tab-1',
          currentVersionId: v(2),
          currentVersionSeq: 1,
        },
      ]),
    );
    versionModel.aggregate.mockReturnValueOnce({
      exec: () =>
        Promise.resolve([
          { _id: 'b-1', seq: 2, text: 'I. Whole.\n\nTwo.' },
          { _id: 'b-2', seq: 1, text: 'Two.' },
        ]),
    });
    const view = await service.profile('quiet-fern', GUEST_VIEWER);
    expect(view).toMatchObject({
      tabs: [
        {
          tabId: 'tab-1',
          paragraphs: [
            {
              blockId: 'b-1',
              kind: 'paragraph',
              label: '',
              text: 'I. Whole.\n\nTwo.',
            },
          ],
        },
        { tabId: 'tab-2', paragraphs: [] },
      ],
    });
  });

  it('starts at zero for a page with no bio block', async () => {
    const { service, blockModel } = setup({ one: page() });
    blockModel.find.mockReturnValueOnce(chain([]));
    const view = await service.profile('quiet-fern', owner);
    expect(view).toMatchObject({ revisions: { bio: 0 } });
  });

  it('lists removed beliefs for the owner and admins, with allowlisted fields', async () => {
    for (const viewer of [owner, admin]) {
      const { service, tabModel } = setup({ one: page() });
      const view = await service.profile('quiet-fern', viewer);
      expect(view).toMatchObject({
        manage: {
          removedTabs: [
            {
              tabId: 'tab-gone',
              title: 'Gone',
              removedAt: '2026-11-01T10:00:00.000Z',
            },
          ],
        },
      });
      expect(JSON.stringify(view)).not.toContain('LEAKED');
      expect(tabModel.find).toHaveBeenCalledWith({
        profileId,
        removedAt: { $exists: true },
      });
    }
    const { service, tabModel } = setup({ one: page() });
    const seen = await service.profile('quiet-fern', member);
    expect(JSON.stringify(seen)).not.toContain('tab-gone');
    expect(tabModel.find).not.toHaveBeenCalledWith(
      expect.objectContaining({ removedAt: { $exists: true } }),
    );
  });
});
