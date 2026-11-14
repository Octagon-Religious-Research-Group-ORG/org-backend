import { strFromU8, unzipSync } from 'fflate';
import { Types } from 'mongoose';
import type { Receipt } from '../anchoring/receipt';
import { leafId } from '../anchoring/schemas/anchor-leaf.schema';
import type { Viewer } from '../members/profile-access';
import {
  fakeModel,
  type FakeModel,
} from '../test-support/fake-model.mocks-spec';
import {
  EXPORT_FORMAT,
  exportReceiptName,
  MAX_EXPORT_RECEIPTS,
  MemberExportService,
} from './member-export.service';

const ME = 'user_me';
const OTHER = 'user_other_person';
const ADMIN = 'user_some_admin';
const T = new Date('2026-11-01T10:00:00Z');
const H = (c: string) => c.repeat(64);

function receiptFor(text: string): Receipt {
  return {
    format: 'org-receipt-v1',
    generatedAt: T.toISOString(),
    subject: { type: 'comment', page: 'x', commentId: 'c' },
    notice: ['A synthetic notice.'],
    versions: [
      {
        kind: 'block',
        seq: 1,
        text,
        serverTime: T.toISOString(),
        disclosure: 'none',
        hashInput: { included: false, withheld: ['authorUserId'], reason: 'r' },
        anchor: { state: 'pending', message: 'pending' },
      },
    ],
    howToVerify: ['step'],
  };
}

function build(overrides: { page?: Record<string, unknown> | null } = {}) {
  const MINE = new Types.ObjectId();
  const OPEN = new Types.ObjectId();
  const HIDDEN = new Types.ObjectId();
  const ORG = new Types.ObjectId();
  const v = (
    blockId: string,
    seq: number,
    extra: Record<string, unknown> = {},
  ) => ({
    _id: new Types.ObjectId(),
    blockId,
    seq,
    text: `${blockId} v${seq}`,
    authorUserId: ME,
    createdAt: T,
    prevHash: H('0'),
    hash: H(String(seq)),
    ...extra,
  });
  const versions = [
    v('ttl_tab1', 1, { authorUserId: 'system:title-before-history' }),
    v('blk-bio', 1, { authorUserId: 'system:import' }),
    v('blk-t1', 1),
    v('blk-t1', 2, { suggestionId: 'c-their-sugg', suggestedBy: OTHER }),
    v('blk-other', 1, { authorUserId: OTHER }),
  ];
  const myCommentVersion = {
    _id: new Types.ObjectId(),
    commentId: 'c-mine',
    seq: 1,
    text: 'My synthetic comment',
    authorUserId: ME,
    createdAt: T,
    prevHash: H('0'),
    hash: H('a'),
  };
  const cv = (commentId: string) => ({
    _id: new Types.ObjectId(),
    commentId,
    seq: 1,
    text: commentId,
    authorUserId: ME,
    createdAt: T,
    prevHash: H('0'),
    hash: H('e'),
  });
  const moreVersions = [cv('c-org'), cv('c-own-page'), cv('c-hidden-page')];
  const m: Record<string, FakeModel> = {
    profiles: fakeModel([
      overrides.page === null
        ? {
            _id: new Types.ObjectId(),
            slug: 'not-mine',
            ownerUserId: OTHER,
            displayName: 'N',
            visibility: 'public',
          }
        : {
            _id: MINE,
            slug: 'my-page',
            displayName: 'My Synthetic Name',
            visibility: 'members',
            anonymous: false,
            reviewStatus: 'approved',
            ownerUserId: ME,
            source: 'native',
            createdAt: T,
            contacts: [{ method: 'signal', value: 'synthetic-handle' }],
            imageIds: ['pic1'],
            similarNameOf: ['someone-else'],
            removal: {
              by: ADMIN,
              reason: 'A moderator note',
              at: T,
              previousStatus: 'approved',
            },
            ...overrides.page,
          },
      {
        _id: OPEN,
        slug: 'open-page',
        displayName: 'Open Person',
        visibility: 'public',
        reviewStatus: 'approved',
        ownerUserId: OTHER,
      },
      {
        _id: HIDDEN,
        slug: 'hidden-page',
        displayName: 'Hidden Person',
        visibility: 'unlisted',
        reviewStatus: 'approved',
        ownerUserId: 'user_hidden',
      },
    ]),
    tabs: fakeModel([
      { profileId: MINE, tabId: 'tab1', title: 'Synthetic belief', order: 0 },
      {
        profileId: MINE,
        tabId: 'tab2',
        title: 'Old tab',
        order: 1,
        removedAt: T,
      },
    ]),
    blocks: fakeModel([
      {
        profileId: MINE,
        blockId: 'blk-bio',
        section: 'bio',
        kind: 'paragraph',
        label: 'I.',
        order: 0,
      },
      {
        profileId: MINE,
        blockId: 'blk-t1',
        section: 'beliefs',
        kind: 'paragraph',
        tabId: 'tab1',
        order: 1,
        removedAt: T,
      },
      {
        profileId: OPEN,
        blockId: 'blk-other',
        section: 'bio',
        kind: 'paragraph',
        order: 0,
      },
    ]),
    versions: fakeModel(versions),
    comments: fakeModel([
      {
        commentId: 'c-mine',
        profileId: OPEN,
        tabId: 'tabX',
        authorUserId: ME,
        body: 'My synthetic comment',
        createdAt: T,
        editedAt: T,
        kind: 'comment',
        stance: 'agree',
        moderation: 'hidden',
        moderatedBy: ADMIN,
      },
      {
        commentId: 'c-org',
        profileId: ORG,
        tabId: 'org-page:about',
        authorUserId: ME,
        body: 'On an ORG page',
        createdAt: T,
      },
      {
        commentId: 'c-hidden-page',
        profileId: HIDDEN,
        authorUserId: ME,
        body: 'On an unlisted page',
        createdAt: T,
        removedAt: T,
        removedBy: ME,
        parentCommentId: 'c-root',
      },
      {
        commentId: 'c-own-page',
        profileId: MINE,
        authorUserId: ME,
        body: 'On my own page',
        createdAt: T,
      },
      {
        commentId: 'c-my-sugg',
        profileId: OPEN,
        authorUserId: ME,
        body: '',
        kind: 'suggestion',
        createdAt: T,
        suggestion: {
          proposedText: 'My wording',
          status: 'accepting',
          decidedBy: OTHER,
        },
      },
      {
        commentId: 'c-my-sugg2',
        profileId: OPEN,
        authorUserId: ME,
        body: '',
        kind: 'suggestion',
        suggestion: { proposedText: 'Declined wording', status: 'declined' },
      },
      {
        commentId: 'c-linked',
        profileId: OPEN,
        legacyAuthorName: 'Synthetic Pages Name',
        linkedUserId: ME,
        linkedBy: ADMIN,
        body: 'Imported',
        legacyCreatedAt: T,
        createdAt: T,
      },
      {
        commentId: 'c-linked-nodate',
        profileId: OPEN,
        legacyAuthorName: 'Synthetic Pages Name',
        linkedUserId: ME,
        body: 'Imported 2',
        createdAt: T,
      },
      {
        commentId: 'c-their',
        profileId: MINE,
        tabId: 'tab1',
        authorUserId: OTHER,
        body: 'Their visible comment',
        anchorText: 'blk-t1 v1',
        createdAt: T,
        parentCommentId: 'c-own-page',
      },
      {
        commentId: 'c-their-hidden',
        profileId: MINE,
        authorUserId: OTHER,
        body: 'Their hidden text',
        moderation: 'hidden',
        moderatedBy: ADMIN,
        createdAt: T,
      },
      {
        commentId: 'c-their-removed',
        profileId: MINE,
        authorUserId: OTHER,
        body: 'Their removed text',
        removedAt: T,
        createdAt: T,
      },
      {
        commentId: 'c-their-sugg',
        profileId: MINE,
        authorUserId: OTHER,
        kind: 'suggestion',
        body: '',
        suggestion: {
          proposedText: 'Their wording',
          status: 'accepted',
          decidedBy: ME,
        },
        createdAt: T,
      },
      {
        commentId: 'c-admin',
        profileId: MINE,
        authorUserId: ADMIN,
        writtenAsAdmin: true,
        body: 'From an admin',
        createdAt: T,
      },
      {
        commentId: 'c-imported',
        profileId: MINE,
        legacyAuthorName: 'A Pages Name',
        body: 'Imported on my page',
        createdAt: T,
      },
      {
        commentId: 'c-elsewhere',
        profileId: OPEN,
        authorUserId: OTHER,
        body: 'Not on my page',
        createdAt: T,
      },
    ]),
    commentVersions: fakeModel([
      myCommentVersion,
      ...moreVersions,
      {
        _id: new Types.ObjectId(),
        commentId: 'c-their',
        seq: 1,
        text: 'Their visible comment',
        authorUserId: OTHER,
        createdAt: T,
        prevHash: H('0'),
        hash: H('b'),
      },
    ]),
    votes: fakeModel([
      {
        profileId: OPEN,
        tabId: 'tabX',
        voterUserId: ME,
        value: 'agree',
        castAt: T,
      },
      {
        profileId: ORG,
        tabId: 'org-page:about',
        voterUserId: ME,
        value: 'disagree',
        castAt: T,
      },
      { profileId: OPEN, tabId: 'tabY', voterUserId: ME },
      { profileId: OPEN, tabId: 'tabX', voterUserId: OTHER, value: 'agree' },
    ]),
    claims: fakeModel([
      {
        profileId: HIDDEN,
        userId: ME,
        message: 'Mine',
        status: 'rejected',
        reason: 'Not proven',
        decidedBy: ADMIN,
        decidedAt: T,
        createdAt: T,
      },
      {
        profileId: OPEN,
        userId: ME,
        message: 'Mine too',
        status: 'pending',
        createdAt: T,
      },
      {
        profileId: OPEN,
        userId: OTHER,
        message: 'Theirs',
        status: 'pending',
        createdAt: T,
      },
    ]),
    reports: fakeModel([
      {
        reporterUserId: ME,
        targetType: 'comment',
        targetId: 'c-elsewhere',
        reason: 'spam',
        note: 'My note',
        status: 'closed',
        resolution: 'hidden',
        resolvedBy: ADMIN,
        createdAt: T,
      },
      {
        reporterUserId: ME,
        targetType: 'member-page',
        targetId: String(OPEN),
        reason: 'other',
        createdAt: T,
      },
      {
        reporterUserId: OTHER,
        targetType: 'member-page',
        targetId: String(MINE),
        reason: 'spam',
        note: 'About me',
        createdAt: T,
      },
    ]),
    prefs: fakeModel([
      { userId: ME, off: ['votes'], digest: false, immediate: true },
    ]),
    consents: fakeModel([
      {
        userId: ME,
        termsVersion: '1',
        termsHash: H('c'),
        acceptedAt: T,
        ip: '203.0.113.5',
      },
      { userId: ME, termsVersion: '2', termsHash: H('d'), acceptedAt: T },
      {
        userId: OTHER,
        termsVersion: '1',
        termsHash: H('c'),
        acceptedAt: T,
        ip: '203.0.113.9',
      },
    ]),
    contacts: fakeModel([
      {
        userId: ME,
        backup: [{ method: 'email', value: 'backup@example.invalid' }],
      },
      {
        userId: OTHER,
        backup: [{ method: 'email', value: 'theirs@example.invalid' }],
      },
    ]),
    leaves: fakeModel(
      [versions[0], versions[1], versions[2], versions[3], versions[4]]
        .map((row) => ({ _id: leafId('block', row._id) }))
        .concat(
          [myCommentVersion, ...moreVersions].map((row) => ({
            _id: leafId('comment', row._id),
          })),
        ),
    ),
  };
  const receipts = {
    exportVersion: jest.fn((...args: unknown[]) =>
      Promise.resolve(receiptFor((args[1] as { text: string }).text)),
    ),
  };
  const authors = {
    resolve: jest.fn(() =>
      Promise.resolve((userId: string, writtenAsAdmin?: boolean) =>
        writtenAsAdmin
          ? { kind: 'admin' }
          : userId === OTHER
            ? { kind: 'member', displayName: 'Open Person' }
            : { kind: 'member' },
      ),
    ),
  };
  const pictures = {
    currentPicture: jest.fn(() => Promise.resolve('pic1')),
    read: jest.fn(() =>
      Promise.resolve({ data: Buffer.from('synthetic-webp'), fileId: 'pic1' }),
    ),
  };
  const service = new MemberExportService(
    m.profiles as never,
    m.tabs as never,
    m.blocks as never,
    m.versions as never,
    m.comments as never,
    m.commentVersions as never,
    m.votes as never,
    m.claims as never,
    m.reports as never,
    m.prefs as never,
    m.consents as never,
    m.contacts as never,
    m.leaves as never,
    receipts as never,
    authors as never,
    pictures as never,
  );
  return {
    service,
    m,
    receipts,
    authors,
    pictures,
    ids: { MINE, OPEN, HIDDEN, ORG },
  };
}

const member: Viewer = { kind: 'named-member', userId: ME, isAdmin: false };

function unpack(zip: Uint8Array) {
  const files = unzipSync(zip);
  const text = Object.fromEntries(
    Object.entries(files)
      .filter(([name]) => !name.endsWith('.zip') && !name.endsWith('.webp'))
      .map(([name, bytes]) => [name, strFromU8(bytes)]),
  );
  const nested = Object.entries(files)
    .filter(([name]) => name.endsWith('.zip'))
    .flatMap(([, bytes]) =>
      Object.values(unzipSync(bytes)).map((inner) => strFromU8(inner)),
    );
  return { files, text, all: [...Object.values(text), ...nested].join('\n') };
}

describe('MemberExportService: what is in it', () => {
  it('holds the page, every version, the member’s comments, votes, claims, reports, consents and settings', async () => {
    const { service } = build();
    const { data, zip } = await service.build(ME, member, T);
    expect(data.format).toBe(EXPORT_FORMAT);
    expect(data.account).toEqual({ userId: ME });
    expect(data.page).toMatchObject({
      address: 'my-page',
      name: 'My Synthetic Name',
      visibility: 'members',
      nickname: false,
      status: 'approved',
      shownContacts: [{ method: 'signal', value: 'synthetic-handle' }],
    });
    expect(data.page!.tabs).toEqual([
      {
        tabId: 'tab1',
        title: 'Synthetic belief',
        titleHistory: [
          {
            seq: 1,
            text: 'ttl_tab1 v1',
            savedAt: T.toISOString(),
            source: 'the title before history began',
          },
        ],
      },
      {
        tabId: 'tab2',
        title: 'Old tab',
        removedAt: T.toISOString(),
        titleHistory: [],
      },
    ]);
    // Sorted by section: beliefs before bio.
    expect(
      data.page!.blocks.map((b) => b.versions.map((x) => x.source)),
    ).toEqual([
      ['written by you', 'a member’s suggestion you accepted'],
      ['imported from Apple Pages'],
    ]);
    expect(data.myComments.map((c) => c.commentId)).toEqual([
      'c-mine',
      'c-org',
      'c-hidden-page',
      'c-own-page',
      'c-my-sugg',
      'c-my-sugg2',
      'c-linked',
      'c-linked-nodate',
    ]);
    expect(data.myComments[0]).toMatchObject({
      place: { type: 'member-page', page: 'open-page', name: 'Open Person' },
      tabId: 'tabX',
      text: 'My synthetic comment',
      stance: 'agree',
      moderation: 'hidden',
      versions: [
        { seq: 1, text: 'My synthetic comment', savedAt: T.toISOString() },
      ],
    });
    expect(data.myComments[1].place).toEqual({
      type: 'org-page',
      page: 'about',
    });
    expect(data.myComments[1]).not.toHaveProperty('tabId');
    expect(data.myComments[3].place).toEqual({ type: 'my-page' });
    expect(data.myComments[4]).toMatchObject({
      kind: 'suggestion',
      suggestion: { proposedText: 'My wording', status: 'pending' },
    });
    expect(data.myComments[5]).toMatchObject({
      suggestion: { status: 'declined' },
    });
    expect(data.myComments[5].postedAt).toBeUndefined();
    expect(data.myComments[6]).toMatchObject({
      importedAs: 'Synthetic Pages Name',
      pagesDate: T.toISOString(),
    });
    expect(data.myComments[7]).not.toHaveProperty('pagesDate');
    expect(data.votes).toEqual([
      {
        place: { type: 'member-page', page: 'open-page', name: 'Open Person' },
        tabId: 'tabX',
        vote: 'agree',
        castAt: T.toISOString(),
      },
      {
        place: { type: 'org-page', page: 'about' },
        vote: 'disagree',
        castAt: T.toISOString(),
      },
      {
        place: { type: 'member-page', page: 'open-page', name: 'Open Person' },
        tabId: 'tabY',
        vote: 'withdrawn',
      },
    ]);
    expect(data.claims).toEqual([
      {
        place: { type: 'member-page' },
        message: 'Mine',
        status: 'rejected',
        reasonGiven: 'Not proven',
        requestedAt: T.toISOString(),
        decidedAt: T.toISOString(),
      },
      {
        place: { type: 'member-page', page: 'open-page', name: 'Open Person' },
        message: 'Mine too',
        status: 'pending',
        requestedAt: T.toISOString(),
      },
    ]);
    expect(data.reportsFiled).toEqual([
      {
        about: 'comment',
        reason: 'spam',
        note: 'My note',
        filedAt: T.toISOString(),
      },
      { about: 'member-page', reason: 'other', filedAt: T.toISOString() },
    ]);
    expect(data.consents).toEqual([
      {
        termsVersion: '1',
        termsHash: H('c'),
        acceptedAt: T.toISOString(),
        ipAddress: '203.0.113.5',
      },
      { termsVersion: '2', termsHash: H('d'), acceptedAt: T.toISOString() },
    ]);
    expect(data.notificationSettings).toEqual({
      categoriesOff: ['votes'],
      dailyDigest: false,
      immediateEmails: true,
    });
    expect(data.backupContacts).toEqual([
      { method: 'email', value: 'backup@example.invalid' },
    ]);

    const { files, text } = unpack(zip);
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        'READ-ME-FIRST.txt',
        'my-data.txt',
        'my-data.json',
        'picture.webp',
      ]),
    );
    expect(JSON.parse(text['my-data.json'])).toEqual(
      JSON.parse(JSON.stringify(data)),
    );
    expect(text['my-data.txt']).toContain(
      'YOUR PAGE: My Synthetic Name (/my-page)',
    );
    expect(text['my-data.txt']).toContain('blk-t1 v2');
  });

  it('gives a receipt for each anchored version of the member’s own, through ReceiptsService', async () => {
    const { service, receipts, m } = build();
    const { data, zip } = await service.build(ME, member, T);
    // Title, two belief text versions, bio, four comment versions: eight.
    // The other person's versions are never asked for.
    expect(receipts.exportVersion).toHaveBeenCalledTimes(8);
    const subjects = receipts.exportVersion.mock.calls.map((call) => call[2]);
    expect(subjects).toEqual([
      { type: 'belief-title', page: 'my-page', tabId: 'tab1' },
      { type: 'belief-text', page: 'my-page', tabId: 'tab1' },
      { type: 'belief-text', page: 'my-page', tabId: 'tab1' },
      {
        type: 'page-block',
        page: 'my-page',
        section: 'bio',
        blockId: 'blk-bio',
      },
      { type: 'comment', page: 'open-page', commentId: 'c-mine' },
      { type: 'org-page-comment', orgPage: 'about', commentId: 'c-org' },
      // A page this member may no longer see is not named, even here.
      { type: 'comment', page: '', commentId: 'c-hidden-page' },
      { type: 'comment', page: 'my-page', commentId: 'c-own-page' },
    ]);
    expect(receipts.exportVersion.mock.calls[3][4]).toBe('I.');
    expect(receipts.exportVersion.mock.calls[1][4]).toBeUndefined();
    expect(data.receipts.included).toHaveLength(8);
    expect(data.receipts).not.toHaveProperty('notIncluded');
    const { files } = unpack(zip);
    expect(
      Object.keys(files).filter((name) => name.startsWith('receipts/')),
    ).toEqual(data.receipts.included);
    // A version with no anchor claim gets none.
    m.leaves.docs.splice(0, 1);
    receipts.exportVersion.mockClear();
    await service.build(ME, member, T);
    expect(receipts.exportVersion).toHaveBeenCalledTimes(7);
  });

  it('reads as a member even when the member is an admin', async () => {
    const { service, receipts } = build();
    await service.build(
      ME,
      { kind: 'named-member', userId: ME, isAdmin: true },
      T,
    );
    for (const call of receipts.exportVersion.mock.calls) {
      expect(call[3]).toEqual({
        kind: 'named-member',
        userId: ME,
        isAdmin: false,
      });
    }
  });

  it('names receipt files by kind, version id and number only', () => {
    const id = new Types.ObjectId();
    expect(
      exportReceiptName({ kind: 'comment', row: { _id: id, seq: 3 } as never }),
    ).toBe(`receipts/comment-${String(id)}-v3.zip`);
  });

  it('stops at the receipt cap and says how many are left out', async () => {
    const { service, m } = build();
    const many = Array.from({ length: MAX_EXPORT_RECEIPTS + 1 }, (_, i) => ({
      _id: new Types.ObjectId(),
      blockId: 'blk-bio',
      seq: i + 2,
      text: 't',
      authorUserId: ME,
      createdAt: T,
      prevHash: H('0'),
      hash: H('9'),
    }));
    m.versions.docs.push(...many);
    m.leaves.docs.push(
      ...many.map((row) => ({ _id: leafId('block', row._id) })),
    );
    const { data } = await service.build(ME, member, T);
    expect(data.receipts.included).toHaveLength(MAX_EXPORT_RECEIPTS);
    // 8 of its own plus 1,001 more, 1,000 included.
    expect(data.receipts.notIncluded).toBe(9);
  });
});

describe('MemberExportService: what is never in it', () => {
  it('holds no other person’s Clerk id, anywhere in the zip', async () => {
    const { service } = build();
    const { zip } = await service.build(ME, member, T);
    const { all } = unpack(zip);
    expect(all).not.toContain(OTHER);
    expect(all).not.toContain(ADMIN);
    expect(all).not.toContain('user_hidden');
  });

  it('holds no moderator note, reporter of the member, reports about them, or admin-only page fields', async () => {
    const { service } = build();
    const { zip } = await service.build(ME, member, T);
    const { all } = unpack(zip);
    expect(all).not.toContain('A moderator note');
    expect(all).not.toContain('About me');
    expect(all).not.toContain('someone-else');
    expect(all).not.toContain('theirs@example.invalid');
    expect(all).not.toContain('203.0.113.9');
    expect(all).not.toContain('Not on my page');
    expect(all).not.toContain('Theirs');
  });

  it('shows others’ comments on the member’s page as the page does: hidden and removed ones without their text', async () => {
    const { service, authors } = build();
    const { data, zip } = await service.build(ME, member, T);
    expect(data.commentsOnMyPage).toEqual([
      {
        commentId: 'c-their',
        tabId: 'tab1',
        replyTo: 'c-own-page',
        kind: 'comment',
        author: { kind: 'member', displayName: 'Open Person' },
        postedAt: T.toISOString(),
        text: 'Their visible comment',
        highlighted: 'blk-t1 v1',
      },
      expect.objectContaining({
        commentId: 'c-their-hidden',
        notShown: 'hidden by a moderator',
      }),
      expect.objectContaining({
        commentId: 'c-their-removed',
        notShown: 'removed by its author',
      }),
      expect.objectContaining({
        commentId: 'c-their-sugg',
        kind: 'suggestion',
        proposedText: 'Their wording',
      }),
      expect.objectContaining({
        commentId: 'c-admin',
        author: { kind: 'admin' },
      }),
      expect.objectContaining({
        commentId: 'c-imported',
        author: { kind: 'imported', name: 'A Pages Name' },
      }),
    ]);
    for (const hidden of data.commentsOnMyPage.slice(1, 3)) {
      expect(hidden).not.toHaveProperty('text');
    }
    const { all } = unpack(zip);
    expect(all).not.toContain('Their hidden text');
    expect(all).not.toContain('Their removed text');
    // Others' comment versions are not exported, only what the page shows.
    expect(authors.resolve).toHaveBeenCalledWith(
      [OTHER, OTHER, OTHER, OTHER, ADMIN],
      {
        ...member,
        isAdmin: false,
      },
    );
  });

  it('names a page the member may no longer see by nothing at all', async () => {
    const { service } = build();
    const { data } = await service.build(ME, member, T);
    expect(data.myComments[2]).toMatchObject({
      place: { type: 'member-page' },
      removedByYouAt: T.toISOString(),
      replyTo: 'c-root',
    });
    expect(JSON.stringify(data)).not.toContain('"hidden-page"');
    expect(JSON.stringify(data)).not.toContain('Hidden Person');
  });

  it('names a page the member sees by name only without its address', async () => {
    const { service, m } = build();
    m.profiles.docs[1].visibility = 'named-members';
    const { data } = await service.build(
      ME,
      { kind: 'signed-in', userId: ME, isAdmin: false },
      T,
    );
    expect(data.myComments[0].place).toEqual({
      type: 'member-page',
      name: 'Open Person',
    });
  });
});

describe('MemberExportService: after "Delete my page", and without a page', () => {
  it('still exports a deleted page, saying so', async () => {
    const { service } = build({
      page: {
        deletedAt: T,
        deletion: {
          at: T,
          source: 'member',
          purgeAfter: new Date('2031-11-01T10:00:00Z'),
        },
        removal: undefined,
        imageIds: undefined,
      },
    });
    const { data, zip } = await service.build(
      ME,
      { kind: 'signed-in', userId: ME, isAdmin: false },
      T,
    );
    expect(data.page).toMatchObject({
      status: 'deleted',
      deletion: {
        deletedAt: T.toISOString(),
        by: 'you',
        keptUntil: '2031-11-01T10:00:00.000Z',
      },
    });
    expect(unpack(zip).text['my-data.txt']).toContain(
      'ORG keeps a private copy until 2031-11-01T10:00:00.000Z',
    );
  });

  it('says when the account deletion took the page, and an admin removal', async () => {
    const gone = build({
      page: {
        deletedAt: T,
        deletion: { at: T, source: 'account-deleted', purgeAfter: T },
        contacts: undefined,
        legacy: { pagesUrl: 'https://pages.invalid/mine', importedAt: T },
        anonymous: true,
      },
    });
    const { data } = await gone.service.build(ME, member, T);
    expect(data.page).toMatchObject({
      deletion: { by: 'your account was deleted' },
      importedFrom: 'https://pages.invalid/mine',
      nickname: true,
      shownContacts: [],
    });
    const removed = build({ page: { reviewStatus: 'removed' } });
    expect(
      (await removed.service.build(ME, member, T)).data.page,
    ).toMatchObject({
      status: 'taken off the site by an admin',
    });
    const old = build({ page: { reviewStatus: undefined } });
    expect((await old.service.build(ME, member, T)).data.page!.status).toBe(
      'approved',
    );
  });

  it('exports an account with no page, no settings and no picture', async () => {
    const { service, m, pictures } = build({ page: null });
    m.prefs.docs.splice(0);
    m.contacts.docs.splice(0);
    pictures.currentPicture.mockResolvedValue(undefined as never);
    const { data, zip } = await service.build(ME, member);
    expect(data.page).toBeNull();
    expect(data.commentsOnMyPage).toEqual([]);
    expect(data.notificationSettings).toBe('default: every email on');
    expect(data.backupContacts).toEqual([]);
    expect(unpack(zip).text['my-data.txt']).toContain(
      'You have no member page.',
    );
    expect(unpack(zip).files).not.toHaveProperty('picture.webp');
  });

  it('exports an account with nothing at all', async () => {
    const { service, m } = build({ page: null });
    for (const model of Object.values(m)) model.docs.splice(0);
    const { data } = await service.build(ME, member, T);
    expect(data.receipts.included).toEqual([]);
    expect(data.myComments).toEqual([]);
  });

  it('includes no picture when the page has none live', async () => {
    const { service, pictures } = build();
    pictures.currentPicture.mockResolvedValue(undefined as never);
    const { zip } = await service.build(ME, member, T);
    expect(unpack(zip).files).not.toHaveProperty('picture.webp');
    expect(pictures.read).not.toHaveBeenCalled();
  });

  it('includes no picture the store cannot read', async () => {
    const { service, pictures } = build();
    pictures.read.mockResolvedValue(undefined as never);
    const { zip } = await service.build(ME, member, T);
    expect(unpack(zip).files).not.toHaveProperty('picture.webp');
  });
});
