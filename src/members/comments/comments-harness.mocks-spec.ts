// The members area with real services over in-memory models (Chunk 9 specs).
// Named so neither the build nor Jest treats it as code or as a suite.
// Every name and text here is synthetic.
import { Types } from 'mongoose';
import { BlockVersionsService } from '../../social/block-versions.service';
import { CommentVersionsService } from '../../social/comment-versions.service';
import { computeVersionHash, GENESIS_HASH } from '../../social/version-chain';
import {
  type FakeModel,
  type FakeModelOptions,
  fakeModel,
} from '../../test-support/fake-model.mocks-spec';
import { MemberHistoryService } from '../member-history.service';
import { MemberPageEditorService } from '../member-page-editor.service';
import { MembersService } from '../members.service';
import { CommentAuthorsService } from './comment-authors.service';
import { CommentWritersService } from './comment-writers';
import { CommentsService } from './comments.service';
import { CommentStore } from './comment-store';
import { SuggestionsService } from './suggestions.service';
import { VoteHistoryService } from '../../social/vote-history.service';
import { VotersService } from '../votes/voters.service';
import { VoteTalliesService } from '../votes/vote-tallies.service';
import { VotesService } from '../votes/votes.service';
import { OrgPagesService } from '../org-pages/org-pages.service';

export const ids = {
  open: new Types.ObjectId(),
  members: new Types.ObjectId(),
  hidden: new Types.ObjectId(),
  waiting: new Types.ObjectId(),
  imported: new Types.ObjectId(),
  named: new Types.ObjectId(),
  anon: new Types.ObjectId(),
  gone: new Types.ObjectId(),
  /** ORG's own pages (Chunk 10b). */
  orgAbout: new Types.ObjectId(),
  orgResearch: new Types.ObjectId(),
};

/** Clerk ids. `user_admin*` are admins; `*unverified*` has no verified email. */
export const U = {
  owner: 'user_owner',
  named: 'user_named',
  anon: 'user_anon',
  waiting: 'user_waiting',
  nopage: 'user_nopage',
  admin: 'user_admin',
  adminWithPage: 'user_admin_paged',
  unverified: 'user_unverified',
  hiddenOwner: 'user_hidden',
  membersOwner: 'user_mowner',
  goneOwner: 'user_gone',
};

const page = (
  _id: Types.ObjectId,
  slug: string,
  owner: string | undefined,
  extra: Record<string, unknown> = {},
) => ({
  _id,
  slug,
  displayName: `Name of ${slug}`,
  visibility: 'public',
  reviewStatus: 'approved',
  anonymous: false,
  ...(owner ? { ownerUserId: owner } : {}),
  imageIds: [],
  contacts: [],
  ...extra,
});

export function seedProfiles() {
  return [
    page(ids.open, 'open-page', U.owner),
    page(ids.members, 'members-page', U.membersOwner, {
      visibility: 'members',
    }),
    page(ids.hidden, 'hidden-page', U.hiddenOwner, { visibility: 'unlisted' }),
    page(ids.waiting, 'waiting-page', U.waiting, { reviewStatus: 'pending' }),
    page(ids.imported, 'imported-page', undefined, { source: 'migrated' }),
    page(ids.named, 'named-writer', U.named),
    page(ids.anon, 'anon-writer', U.anon, {
      anonymous: true,
      visibility: 'members',
    }),
    page(new Types.ObjectId(), 'admin-page', U.adminWithPage, {
      visibility: 'unlisted',
    }),
    page(new Types.ObjectId(), 'unverified-page', U.unverified),
    page(ids.gone, 'gone-page', U.goneOwner, { deletedAt: new Date(0) }),
  ];
}

export function seedTabs() {
  const tab = (
    profileId: Types.ObjectId,
    tabId: string,
    order: number,
    extra: Record<string, unknown> = {},
  ) => ({
    profileId,
    tabId,
    title: `Title ${tabId}`,
    order,
    reviewStatus: 'confirmed',
    ...extra,
  });
  return [
    tab(ids.open, 'tab_a', 0),
    tab(ids.open, 'tab_b', 1),
    tab(ids.open, 'tab_removed', 2, { removedAt: new Date(0) }),
    tab(ids.members, 'tab_m', 0),
    tab(ids.hidden, 'tab_h', 0),
    tab(ids.waiting, 'tab_w', 0),
    tab(ids.imported, 'tab_i', 0, { reviewStatus: 'imported-review' }),
    tab(ids.named, 'tab_n', 0),
  ];
}

/** One paragraph block with its first version, hash-chained for real. */
function blockWithVersion(
  profileId: Types.ObjectId,
  blockId: string,
  tabId: string | undefined,
  text: string,
  order: number,
  label = '',
) {
  const createdAt = new Date('2026-11-01T10:00:00.000Z');
  const fields = {
    blockId,
    seq: 1,
    text,
    authorUserId: 'system:import',
    createdAt,
    prevHash: GENESIS_HASH,
  };
  return {
    block: {
      profileId,
      blockId,
      section: tabId ? 'beliefs' : 'bio',
      kind: 'paragraph',
      ...(tabId ? { tabId } : {}),
      label,
      order,
      currentVersionSeq: 1,
    },
    version: { ...fields, hash: computeVersionHash(fields) },
  };
}

export function seedBlocks() {
  return [
    blockWithVersion(ids.open, 'blk_a1', 'tab_a', 'Synthetic belief A.', 0),
    blockWithVersion(ids.open, 'blk_b1', 'tab_b', 'Synthetic belief B.', 0),
    blockWithVersion(ids.members, 'blk_m1', 'tab_m', 'Members belief.', 0),
    blockWithVersion(ids.hidden, 'blk_h1', 'tab_h', 'Hidden belief.', 0),
    blockWithVersion(ids.waiting, 'blk_w1', 'tab_w', 'Waiting belief.', 0),
    blockWithVersion(ids.imported, 'blk_i1', 'tab_i', 'First part.', 0, 'I.'),
    blockWithVersion(ids.imported, 'blk_i2', 'tab_i', 'Second part.', 1, 'A.'),
    blockWithVersion(ids.named, 'blk_n1', 'tab_n', 'Named belief.', 0),
  ];
}

/**
 * Two of ORG's published pages (Chunk 10b): 'about' at revision 1 and
 * 'research' at revision 2. Every other page id is known but not stored, so
 * it reads as not published.
 */
export function seedOrgPages() {
  const stored = (_id: Types.ObjectId, pageId: string, revision: number) => ({
    _id,
    pageId,
    published: {
      revision,
      content: { kind: 'reference', id: pageId, title: 'Synthetic' },
      publishedAt: new Date('2026-11-01T09:00:00.000Z'),
      publishedBy: 'system:test',
    },
    history: [],
    createdAt: new Date('2026-10-01T09:00:00.000Z'),
  });
  return [
    stored(ids.orgAbout, 'about', 1),
    stored(ids.orgResearch, 'research', 2),
  ];
}

export function seedImportedComments() {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute, 0));
  return [
    {
      commentId: 'cmt_imp1',
      profileId: ids.imported,
      tabId: 'tab_i',
      anchorBlockId: 'blk_i2',
      anchorText: 'Second part',
      legacyAuthorName: 'Synthetic Pages Author',
      legacyCreatedAt: new Date('2020-05-06T00:00:00.000Z'),
      body: 'An imported synthetic comment.',
      source: 'migrated',
      createdAt: at(0),
    },
    {
      commentId: 'cmt_imp2',
      profileId: ids.imported,
      tabId: 'tab_i',
      parentCommentId: 'cmt_imp1',
      legacyAuthorName: 'Another Pages Author',
      body: 'An imported synthetic reply.',
      source: 'migrated',
      createdAt: at(1),
    },
    {
      // A reply to a reply, as an import can hold: shown under the root.
      commentId: 'cmt_imp3',
      profileId: ids.imported,
      tabId: 'tab_i',
      parentCommentId: 'cmt_imp2',
      legacyAuthorName: 'Synthetic Pages Author',
      body: 'An imported reply to a reply.',
      source: 'migrated',
      createdAt: at(2),
    },
    {
      commentId: 'cmt_imp4',
      profileId: ids.imported,
      anchorText: 'unplaced highlight',
      legacyAuthorName: 'Synthetic Pages Author',
      body: 'An imported page-level comment.',
      source: 'migrated',
      createdAt: at(3),
    },
    {
      commentId: 'cmt_old_removed_tab',
      profileId: ids.open,
      tabId: 'tab_removed',
      legacyAuthorName: 'Synthetic Pages Author',
      body: 'On a belief that was removed.',
      source: 'migrated',
      createdAt: at(4),
    },
  ];
}

export function request(userId?: string) {
  return {
    headers: userId ? { authorization: `Bearer ${userId}` } : {},
    ...(userId ? { auth: { payload: { sub: userId } } } : {}),
  } as never;
}

export interface Harness {
  profiles: FakeModel;
  tabs: FakeModel;
  blocks: FakeModel;
  versions: FakeModel;
  comments: FakeModel;
  commentVersions: FakeModel;
  members: MembersService;
  editor: MemberPageEditorService;
  history: MemberHistoryService;
  commentsService: CommentsService;
  suggestions: SuggestionsService;
  writers: CommentWritersService;
  clerk: { getIdentity: jest.Mock };
  votes: FakeModel;
  tallies: FakeModel;
  voteHistory: FakeModel;
  /** ORG's CMS pages (Chunk 10b). */
  pages: FakeModel;
  orgPages: OrgPagesService;
  /** The admin setting; flip `anonymous` to let anonymous votes count. */
  settings: { anonymous: boolean; anonymousMayVote: jest.Mock };
  talliesService: VoteTalliesService;
  voteHistoryService: VoteHistoryService;
  voters: VotersService;
  votesService: VotesService;
  /** The viewer as the server resolves it from a token. */
  viewer: (userId?: string) => ReturnType<MembersService['resolveViewer']>;
  /** A writer, or the refusal. */
  writer: (
    userId: string,
  ) => ReturnType<CommentWritersService['requireWriter']>;
  store: CommentStore;
  /** A thread as the controller reads it, with the viewer's write status. */
  thread: (
    slug: string,
    viewer: Awaited<ReturnType<MembersService['resolveViewer']>>,
    tabId?: string,
    after?: string,
  ) => ReturnType<CommentsService['thread']>;
}

export function harness(
  faults: {
    comments?: FakeModelOptions['beforeWrite'];
    votes?: FakeModelOptions['beforeWrite'];
    voteHistory?: FakeModelOptions['beforeWrite'];
  } = {},
): Harness {
  const seeded = seedBlocks();
  const profiles = fakeModel(seedProfiles());
  const tabs = fakeModel(seedTabs(), { timestamps: true });
  const blocks = fakeModel(
    seeded.map((s) => s.block),
    { unique: [['blockId']], timestamps: true },
  );
  const versions = fakeModel(
    seeded.map((s) => s.version),
    { unique: [['blockId', 'seq']] },
  );
  const comments = fakeModel(seedImportedComments(), {
    unique: [['commentId']],
    timestamps: true,
    beforeWrite: faults.comments,
  });
  const commentVersions = fakeModel([], { unique: [['commentId', 'seq']] });
  const votes = fakeModel([], {
    unique: [['tabId', 'voterUserId']],
    timestamps: true,
    beforeWrite: faults.votes,
  });
  const tallies = fakeModel([], { unique: [['tabId']], timestamps: true });
  const voteHistory = fakeModel([], {
    unique: [['voteKey', 'seq']],
    beforeWrite: faults.voteHistory,
  });
  const pages = fakeModel(seedOrgPages(), { unique: [['pageId']] });
  const orgPages = new OrgPagesService(pages as never);
  const setting = { anonymous: false };
  const settings = Object.assign(setting, {
    anonymousMayVote: jest.fn(() => Promise.resolve(setting.anonymous)),
  });

  const adminAccess = {
    isAdminForRead: jest.fn((req: { auth: { payload: { sub: string } } }) =>
      Promise.resolve(req.auth.payload.sub.startsWith('user_admin')),
    ),
  };
  const clerk = {
    getIdentity: jest.fn((userId: string) =>
      Promise.resolve(
        userId.includes('unverified')
          ? { email: 'someone@example.test', emailVerified: false }
          : { email: `${userId}@example.test`, emailVerified: true },
      ),
    ),
  };
  const pictures = {
    currentPicture: jest.fn(() => Promise.resolve(undefined)),
  };

  const members = new MembersService(
    profiles as never,
    tabs as never,
    blocks as never,
    versions as never,
    comments as never,
    pictures as never,
    {} as never,
    adminAccess as never,
  );
  const blockVersions = new BlockVersionsService(
    versions as never,
    blocks as never,
  );
  const talliesService = new VoteTalliesService(
    tallies as never,
    votes as never,
    tabs as never,
    blocks as never,
    versions as never,
    orgPages,
  );
  const editor = new MemberPageEditorService(
    profiles as never,
    tabs as never,
    blocks as never,
    versions as never,
    blockVersions,
    talliesService,
  );
  const commentVersionService = new CommentVersionsService(
    commentVersions as never,
  );
  const authors = new CommentAuthorsService(profiles as never);
  const store = new CommentStore(comments as never);
  const commentsService = new CommentsService(
    tabs as never,
    store,
    members,
    editor,
    commentVersionService,
    authors,
    votes as never,
    orgPages,
  );
  const suggestions = new SuggestionsService(
    comments as never,
    profiles as never,
    blocks as never,
    versions as never,
    store,
    commentsService,
    editor,
    commentVersionService,
  );
  const writers = new CommentWritersService(members, clerk as never);
  const voters = new VotersService(writers);
  const voteHistoryService = new VoteHistoryService(voteHistory as never);
  const votesService = new VotesService(
    votes as never,
    tallies as never,
    tabs as never,
    profiles as never,
    blocks as never,
    versions as never,
    members,
    voters,
    talliesService,
    voteHistoryService,
    settings as never,
    orgPages,
  );
  const history = new MemberHistoryService(
    members,
    tabs as never,
    blocks as never,
    versions as never,
    authors,
    comments as never,
  );
  return {
    profiles,
    tabs,
    blocks,
    versions,
    comments,
    commentVersions,
    members,
    editor,
    history,
    commentsService,
    suggestions,
    writers,
    clerk,
    store,
    votes,
    tallies,
    voteHistory,
    pages,
    orgPages,
    settings,
    talliesService,
    voteHistoryService,
    voters,
    votesService,
    viewer: (userId) => members.resolveViewer(request(userId)),
    thread: async (slug, viewer, tabId, after) =>
      commentsService.thread(
        slug,
        viewer,
        tabId,
        after,
        await writers.writeStatus(viewer),
      ),
    writer: (userId) => writers.requireWriter(request(userId)),
  };
}
