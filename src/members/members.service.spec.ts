/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
import { Logger, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { MAX_PAGE_COMMENTS } from './comments/comment-limits';
import { MAX_DIRECTORY_CARDS, MembersService } from './members.service';
import { GUEST_VIEWER, type Viewer } from './profile-access';

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
const v = (n: number) => new Types.ObjectId(String(n).padStart(24, 'a'));

const FORBIDDEN = {
  similarNameOf: ['secret-lookalike'],
  legacy: { pagesUrl: 'https://legacy.example/secret-doc' },
  authEmail: 'secret@example.test',
};

function page(overrides: Record<string, unknown> = {}) {
  return {
    _id: profileId,
    slug: 'quiet-fern',
    displayName: 'Quiet Fern',
    visibility: 'public',
    reviewStatus: 'approved',
    ownerUserId: 'user_owner',
    imageIds: ['img1'],
    contacts: [{ method: 'signal', value: '@fern', _id: 'row', extra: 'x' }],
    ...FORBIDDEN,
    ...overrides,
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
    kind: 'outline-item',
    label: 'I.',
    tabId: 'tab-1',
    currentVersionId: v(2),
  },
  {
    blockId: 'b-img',
    section: 'beliefs',
    kind: 'image',
    tabId: 'tab-1',
    currentVersionId: v(3),
  },
  {
    blockId: 'b-legal',
    section: 'legal',
    kind: 'paragraph',
    currentVersionId: v(4),
  },
  {
    blockId: 'b-contact',
    section: 'contact',
    kind: 'paragraph',
    currentVersionId: v(5),
  },
  {
    blockId: 'b-other',
    section: 'other',
    kind: 'heading',
    currentVersionId: v(6),
  },
  { blockId: 'b-noversion', section: 'bio', kind: 'paragraph' },
];
const VERSIONS = [
  { _id: v(1), text: 'Synthetic bio' },
  { _id: v(2), text: 'Synthetic belief' },
  { _id: v(3), text: 'image:abc' },
  { _id: v(4), text: 'SECRET LEGAL TEXT' },
  { _id: v(5), text: 'SECRET CONTACT TEXT' },
  { _id: v(6), text: 'My own heading' },
];
const TABS = [
  {
    tabId: 'tab-1',
    title: 'One',
    group: 'Theology',
    reviewStatus: 'imported-review',
  },
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
const anonymousMember: Viewer = {
  kind: 'anonymous-member',
  userId: 'user_a',
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

function setup(
  options: {
    one?: unknown;
    many?: unknown[];
    own?: unknown;
    live?: string[];
    comments?: unknown[];
  } = {},
) {
  const live = new Set(options.live ?? ['img1']);
  const directoryQuery = chain(options.many ?? []);
  const profileModel = {
    findOne: jest.fn((filter: Record<string, unknown>) =>
      chain(
        'ownerUserId' in filter ? (options.own ?? null) : (options.one ?? null),
      ),
    ),
    find: jest.fn(() => directoryQuery),
  };
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
    read: jest.fn(() =>
      Promise.resolve({ data: Buffer.from('webp'), fileId: 'img1' }),
    ),
    livePictures: jest.fn((ids: string[]) =>
      Promise.resolve(new Set(ids.filter((id) => live.has(id)))),
    ),
    currentPicture: jest.fn((ids: string[]) =>
      Promise.resolve(ids.find((id) => live.has(id))),
    ),
  };
  const settings = { votingInvite: jest.fn(() => Promise.resolve(undefined)) };
  const commentModel = { find: jest.fn(() => chain(options.comments ?? [])) };
  const adminAccess = { isAdminForRead: jest.fn(() => Promise.resolve(false)) };
  const service = new MembersService(
    profileModel as never,
    tabModel as never,
    blockModel as never,
    versionModel as never,
    commentModel as never,
    pictures as never,
    settings as never,
    adminAccess as never,
  );
  return {
    service,
    profileModel,
    blockModel,
    tabModel,
    versionModel,
    pictures,
    settings,
    adminAccess,
    directoryQuery,
  };
}

const request = (sub?: string) =>
  (sub ? { auth: { payload: { sub } } } : {}) as AuthenticatedRequest;

async function notFound(run: () => Promise<unknown>) {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(NotFoundException);
  return (error as NotFoundException).getResponse();
}

describe('MembersService.resolveViewer', () => {
  it('reads a request with no token as a guest', async () => {
    const { service, profileModel } = setup();
    await expect(service.resolveViewer(request())).resolves.toEqual(
      GUEST_VIEWER,
    );
    expect(profileModel.findOne).not.toHaveBeenCalled();
  });

  it('reads an account with no page as signed in', async () => {
    const { service } = setup({ own: null });
    await expect(service.resolveViewer(request('u1'))).resolves.toEqual({
      kind: 'signed-in',
      userId: 'u1',
      isAdmin: false,
    });
  });

  it.each([
    ['pending', { reviewStatus: 'pending' }],
    ['claiming', { reviewStatus: 'claiming' }],
    ['deleted', { reviewStatus: 'approved', deletedAt: new Date(0) }],
  ])('a %s page does not make a member', async (_name, own) => {
    const { service } = setup({ own });
    const viewer = await service.resolveViewer(request('u1'));
    expect(viewer.kind).toBe('signed-in');
  });

  it('tells nickname members from named members', async () => {
    const anon = setup({ own: { reviewStatus: 'approved', anonymous: true } });
    expect((await anon.service.resolveViewer(request('u1'))).kind).toBe(
      'anonymous-member',
    );
    const named = setup({ own: { anonymous: false } });
    expect((await named.service.resolveViewer(request('u1'))).kind).toBe(
      'named-member',
    );
  });

  it('takes the admin flag from the admin check', async () => {
    const { service, adminAccess } = setup();
    adminAccess.isAdminForRead.mockResolvedValueOnce(true);
    expect((await service.resolveViewer(request('u1'))).isAdmin).toBe(true);
  });

  it.each([[new Error('clerk down')], ['clerk down']])(
    'is not an admin when the role cannot be read (%s)',
    async (failure) => {
      const { service, adminAccess } = setup();
      adminAccess.isAdminForRead.mockRejectedValueOnce(failure);
      expect((await service.resolveViewer(request('u1'))).isAdmin).toBe(false);
    },
  );
});

describe('MembersService.directory', () => {
  it('asks the database only for listable pages', async () => {
    const { service, profileModel } = setup();
    await service.directory(GUEST_VIEWER);
    expect(profileModel.find).toHaveBeenCalledWith({
      visibility: { $in: ['public', 'members', 'named-members'] },
      reviewStatus: { $nin: ['claiming', 'pending'] },
      deletedAt: { $exists: false },
    });
  });

  it('drops rows it should never list, even if the query returned them', async () => {
    const { service } = setup({
      many: [
        page({ slug: 'unlisted-page', visibility: 'unlisted' }),
        page({ slug: 'pending-page', reviewStatus: 'pending' }),
        page({ slug: 'claiming-page', reviewStatus: 'claiming' }),
        page({ slug: 'deleted-page', deletedAt: new Date(0) }),
      ],
    });
    for (const viewer of [GUEST_VIEWER, member, owner, admin]) {
      expect((await service.directory(viewer)).members).toEqual([]);
    }
  });

  it('gives a name-only card with no picture to a viewer not entitled', async () => {
    const { service } = setup({ many: [page({ visibility: 'members' })] });
    const { members } = await service.directory(GUEST_VIEWER);
    expect(members).toEqual([
      {
        slug: 'quiet-fern',
        displayName: 'Quiet Fern',
        access: 'name-only',
        hasPicture: false,
        picturePublic: false,
      },
    ]);
  });

  it('gives the picture to an entitled member, marked as not public', async () => {
    const { service } = setup({ many: [page({ visibility: 'members' })] });
    const [card] = (await service.directory(anonymousMember)).members;
    expect(card).toMatchObject({
      access: 'full',
      hasPicture: true,
      picturePublic: false,
    });
  });

  it('marks a public page picture as public', async () => {
    const { service } = setup({ many: [page()] });
    const [card] = (await service.directory(GUEST_VIEWER)).members;
    expect(card).toMatchObject({ hasPicture: true, picturePublic: true });
  });

  it('never returns a field that is not on the allowlist', async () => {
    const { service } = setup({ many: [page()] });
    const json = JSON.stringify(await service.directory(admin));
    expect(json).not.toMatch(/secret|user_owner|ownerUserId/i);
  });

  it('shows no picture on a card whose files are all gallery photos', async () => {
    const { service } = setup({ many: [page({ imageIds: ['gallery-1'] })] });
    const [card] = (await service.directory(GUEST_VIEWER)).members;
    expect(card.hasPicture).toBe(false);
  });

  it('never looks up the picture of a name-only card', async () => {
    const { service, pictures } = setup({
      many: [page({ visibility: 'members' })],
    });
    await service.directory(GUEST_VIEWER);
    expect(pictures.livePictures).toHaveBeenCalledWith([]);
  });

  it('sorts by name and says when the list was cut', async () => {
    const rows = Array.from({ length: MAX_DIRECTORY_CARDS + 1 }, (_, i) =>
      page({ slug: `p-${i}`, displayName: i === 0 ? 'zeta' : 'Alpha' }),
    );
    const { service } = setup({ many: rows });
    const result = await service.directory(GUEST_VIEWER);
    expect(result.hasMore).toBe(true);
    expect(result.members).toHaveLength(MAX_DIRECTORY_CARDS);
    expect(result.members[0].displayName).toBe('Alpha');
  });

  it('reports a complete list', async () => {
    const { service } = setup({ many: [page({ imageIds: undefined })] });
    const result = await service.directory(GUEST_VIEWER);
    expect(result.hasMore).toBe(false);
    expect(result.members[0].hasPicture).toBe(false);
  });
});

describe('MembersService.profile', () => {
  it('answers a malformed or over-long address with the page-missing 404', async () => {
    const { service, profileModel } = setup();
    await notFound(() => service.profile('../etc', GUEST_VIEWER));
    await notFound(() => service.profile('a'.repeat(81), GUEST_VIEWER));
    expect(profileModel.findOne).not.toHaveBeenCalled();
  });

  it('looks addresses up in lower case', async () => {
    const { service, profileModel } = setup({ one: page() });
    await service.profile('Quiet-Fern', GUEST_VIEWER);
    expect(profileModel.findOne).toHaveBeenCalledWith({ slug: 'quiet-fern' });
  });

  it.each([
    ['unlisted', page({ visibility: 'unlisted' })],
    ['pending', page({ reviewStatus: 'pending' })],
    ['claiming', page({ reviewStatus: 'claiming' })],
    ['deleted', page({ deletedAt: new Date(0) })],
  ])(
    'hides a %s page behind the same 404 as a missing one',
    async (_n, row) => {
      const missing = await notFound(() =>
        setup({ one: null }).service.profile('quiet-fern', GUEST_VIEWER),
      );
      const hidden = await notFound(() =>
        setup({ one: row }).service.profile('quiet-fern', GUEST_VIEWER),
      );
      expect(hidden).toEqual(missing);
    },
  );

  it('gives a viewer not entitled the name only, and reads no content', async () => {
    const { service, blockModel, tabModel } = setup({
      one: page({ visibility: 'named-members' }),
    });
    const view = await service.profile('quiet-fern', anonymousMember);
    expect(view).toEqual({
      access: 'name-only',
      slug: 'quiet-fern',
      displayName: 'Quiet Fern',
      isOwner: false,
      hasPicture: false,
      picturePublic: false,
    });
    expect(blockModel.find).not.toHaveBeenCalled();
    expect(tabModel.find).not.toHaveBeenCalled();
  });

  it('never serves Legal, the contact section or inline images', async () => {
    const { service } = setup({ one: page() });
    const json = JSON.stringify(await service.profile('quiet-fern', admin));
    expect(json).not.toMatch(/SECRET|image:abc/);
  });

  it('never asks the database for a removed block', async () => {
    const { service, blockModel } = setup({ one: page() });
    await service.profile('quiet-fern', GUEST_VIEWER);
    expect(blockModel.find).toHaveBeenCalledWith(
      expect.objectContaining({ removedAt: { $exists: false } }),
    );
  });

  it('sends the owner the page source, and nobody else', async () => {
    const row = page({ source: 'native' });
    const own = await setup({ one: row }).service.profile('quiet-fern', owner);
    expect(own).toMatchObject({ manage: { source: 'native' } });
    const other = await setup({ one: row }).service.profile(
      'quiet-fern',
      member,
    );
    expect(JSON.stringify(other)).not.toContain('native');
  });

  it('has no picture when the page lists only gallery photos', async () => {
    const { service } = setup({
      one: page({ imageIds: ['gallery-1'] }),
    });
    await expect(
      service.profile('quiet-fern', GUEST_VIEWER),
    ).resolves.toMatchObject({ hasPicture: false });
  });

  it('gives the file a version only when there is a picture', async () => {
    const { service } = setup({ one: page() });
    await expect(
      service.profile('quiet-fern', GUEST_VIEWER),
    ).resolves.toMatchObject({ hasPicture: true, pictureVersion: 'img1' });
    const none = await setup({
      one: page({ imageIds: ['gallery-1'] }),
    }).service.profile('quiet-fern', GUEST_VIEWER);
    expect(none).not.toHaveProperty('pictureVersion');
  });

  it('only ever asks the database for the shown sections', async () => {
    const { service, blockModel } = setup({ one: page() });
    await service.profile('quiet-fern', GUEST_VIEWER);
    expect(blockModel.find).toHaveBeenCalledWith(
      expect.objectContaining({
        section: { $in: ['bio', 'beliefs', 'considering', 'texts', 'other'] },
      }),
    );
  });

  it('never returns a field that is not on the allowlist', async () => {
    const { service } = setup({ one: page() });
    const json = JSON.stringify(await service.profile('quiet-fern', admin));
    expect(json).not.toMatch(/secret|user_owner|ownerUserId|"_id"/i);
  });

  it('builds the page: bio, extras, tabs, groups, the review flag and comment counts', async () => {
    const { service } = setup({
      one: page(),
      comments: [
        { commentId: 'c1', tabId: 'tab-1' },
        // A reply counts in its top-level comment's thread, whatever its tab.
        { commentId: 'c2', tabId: 'tab-2', parentCommentId: 'c1' },
        // Removed: keeps its place, not counted.
        { commentId: 'c3', tabId: 'tab-1', removedAt: new Date() },
        { commentId: 'c4' },
      ],
    });
    await expect(service.profile('quiet-fern', GUEST_VIEWER)).resolves.toEqual({
      access: 'full',
      slug: 'quiet-fern',
      displayName: 'Quiet Fern',
      isOwner: false,
      hasPicture: true,
      pictureVersion: 'img1',
      picturePublic: true,
      contacts: [{ method: 'signal', value: '@fern' }],
      bio: [
        {
          blockId: 'b-bio',
          kind: 'paragraph',
          label: '',
          text: 'Synthetic bio',
        },
      ],
      extras: [
        {
          section: 'other',
          paragraphs: [
            {
              blockId: 'b-other',
              kind: 'heading',
              label: '',
              text: 'My own heading',
            },
          ],
        },
      ],
      tabs: [
        {
          tabId: 'tab-1',
          title: 'One',
          group: 'Theology',
          needsReview: true,
          paragraphs: [
            {
              blockId: 'b-1',
              kind: 'outline-item',
              label: 'I.',
              text: 'Synthetic belief',
            },
          ],
          commentCount: 2,
          textSeq: 1,
        },
        {
          tabId: 'tab-2',
          title: 'Two',
          needsReview: false,
          paragraphs: [],
          commentCount: 0,
          textSeq: 0,
        },
      ],
      pageCommentCount: 1,
    });
  });

  it('reads at most MAX_PAGE_COMMENTS comment rows, and says so in the log', async () => {
    const { service } = setup({
      one: page(),
      comments: Array.from({ length: MAX_PAGE_COMMENTS }, (_, i) => ({
        commentId: `c${i}`,
        tabId: 'tab-1',
      })),
    });
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const view = await service.profile('quiet-fern', GUEST_VIEWER);
    expect(view).toMatchObject({
      tabs: [
        expect.objectContaining({ commentCount: MAX_PAGE_COMMENTS }),
        expect.anything(),
      ],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('20000'));
    warn.mockRestore();
  });

  it('tells the owner it is theirs and gives them the settings', async () => {
    const { service } = setup({ one: page({ reviewStatus: undefined }) });
    const view = await service.profile('quiet-fern', owner);
    expect(view).toMatchObject({
      isOwner: true,
      manage: { visibility: 'public', reviewStatus: 'approved' },
    });
  });

  it('shows the owner and admins a pending page with its status', async () => {
    const row = page({ reviewStatus: 'pending', visibility: 'unlisted' });
    for (const viewer of [owner, admin]) {
      const view = await setup({ one: row }).service.profile(
        'quiet-fern',
        viewer,
      );
      expect(view).toMatchObject({
        access: 'full',
        picturePublic: false,
        manage: { visibility: 'unlisted', reviewStatus: 'pending' },
      });
    }
  });

  it('keeps the settings from everyone else', async () => {
    const view = await setup({ one: page() }).service.profile(
      'quiet-fern',
      member,
    );
    expect(view).not.toHaveProperty('manage');
  });

  it('copes with a page that has no contacts or pictures', async () => {
    const { service } = setup({
      one: page({ contacts: undefined, imageIds: undefined }),
    });
    await expect(
      service.profile('quiet-fern', GUEST_VIEWER),
    ).resolves.toMatchObject({ contacts: [], hasPicture: false });
  });
});

describe('MembersService.picture', () => {
  it('serves a public page picture and says it is public', async () => {
    const { service, pictures } = setup({ one: page() });
    await expect(service.picture('quiet-fern', GUEST_VIEWER)).resolves.toEqual({
      picture: { data: Buffer.from('webp'), fileId: 'img1' },
      isPublic: true,
    });
    expect(pictures.read).toHaveBeenCalledWith('img1');
  });

  it('serves a members page picture to a member, marked not public', async () => {
    const { service } = setup({ one: page({ visibility: 'members' }) });
    await expect(service.picture('quiet-fern', member)).resolves.toMatchObject({
      isPublic: false,
    });
  });

  it.each([
    ['members', 'name-only', page({ visibility: 'members' })],
    ['unlisted', 'none', page({ visibility: 'unlisted' })],
    ['pending', 'none', page({ reviewStatus: 'pending' })],
    ['deleted', 'none', page({ deletedAt: new Date(0) })],
  ])('refuses a %s page to a guest (%s)', async (_v, _level, row) => {
    const { service, pictures } = setup({ one: row });
    await notFound(() => service.picture('quiet-fern', GUEST_VIEWER));
    expect(pictures.read).not.toHaveBeenCalled();
  });

  it('answers 404 for a page with only gallery photos', async () => {
    const { service, pictures } = setup({
      one: page({ imageIds: ['gallery-1'] }),
    });
    await notFound(() => service.picture('quiet-fern', GUEST_VIEWER));
    expect(pictures.read).not.toHaveBeenCalled();
  });

  it('serves the file that is the picture, not the first listed', async () => {
    const { service, pictures } = setup({
      one: page({ imageIds: ['gallery-1', 'img1'] }),
    });
    await service.picture('quiet-fern', GUEST_VIEWER);
    expect(pictures.read).toHaveBeenCalledWith('img1');
  });

  it('answers 404 when there is no picture or the file is gone', async () => {
    await notFound(() =>
      setup({ one: page({ imageIds: [] }) }).service.picture(
        'quiet-fern',
        GUEST_VIEWER,
      ),
    );
    await notFound(() =>
      setup({ one: page({ imageIds: undefined }) }).service.picture(
        'quiet-fern',
        GUEST_VIEWER,
      ),
    );
    const gone = setup({ one: page() });
    gone.pictures.read.mockResolvedValueOnce(undefined as never);
    await notFound(() => gone.service.picture('quiet-fern', GUEST_VIEWER));
  });
});

describe('MembersService.chats', () => {
  it.each([
    ['guest', GUEST_VIEWER],
    ['signed-in', owner],
    ['admin with no page', admin],
  ])('hides the invite from a %s', async (_n, viewer) => {
    const { service, settings } = setup();
    await expect(service.chats(viewer)).resolves.toEqual({ voting: 'hidden' });
    expect(settings.votingInvite).not.toHaveBeenCalled();
  });

  it('says ask Tripp when no invite is set', async () => {
    await expect(setup().service.chats(member)).resolves.toEqual({
      voting: 'ask-tripp',
    });
  });

  it('gives the invite to approved members, anonymous ones too', async () => {
    const { service, settings } = setup();
    settings.votingInvite.mockResolvedValue('https://t.me/+abc' as never);
    await expect(service.chats(anonymousMember)).resolves.toEqual({
      voting: 'invite',
      inviteUrl: 'https://t.me/+abc',
    });
  });
});
