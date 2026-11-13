import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  harness,
  type Harness,
  ids,
  U,
} from '../comments/comments-harness.mocks-spec';
import {
  COMMENT_NOT_FOUND,
  STANCE_EARLIER_VERSION,
  STANCE_NEEDS_PAGE_VOTE,
  STANCE_ONLY_ON_BELIEF,
  stanceOtherVote,
} from '../comments/comments.service';
import {
  ANONYMOUS_VOTING_OFF,
  NEEDS_APPROVED_PAGE_TO_VOTE,
  VERIFY_EMAIL_TO_VOTE,
} from '../votes/voters.service';
import { ORG_PAGE_VOTE_STALE } from '../votes/votes.service';
import {
  isOrgPageId,
  NOT_AN_ORG_PAGE,
  orgPageIdOfThread,
  orgPageThreadId,
} from './org-page-targets';
import { ORG_PAGE_NOT_FOUND, OrgPagesService } from './org-pages.service';

/** Votes and comments on ORG's own pages (Chunk 10b). Synthetic data only. */

const ABOUT = 'org-page:about';

/** Publishes a new revision of a stored page, as the CMS does. */
function publish(h: Harness, pageId: string, revision: number) {
  const page = h.pages.docs.find((p) => p.pageId === pageId)!;
  (page.published as { revision: number }).revision = revision;
}

function unpublish(h: Harness, pageId: string) {
  const at = h.pages.docs.findIndex((p) => p.pageId === pageId);
  h.pages.docs.splice(at, 1);
}

async function cast(
  h: Harness,
  userId: string,
  value: 'agree' | 'disagree',
  baseSeq = 1,
  pageId = 'about',
) {
  return h.votesService.castOnOrgPage(await h.viewer(userId), {
    pageId,
    value,
    baseSeq,
  });
}

async function withdraw(h: Harness, userId: string, pageId = 'about') {
  return h.votesService.withdrawOnOrgPage(
    { ...(await h.viewer(userId)), userId },
    pageId,
  );
}

async function orgThread(h: Harness, userId?: string, pageId = 'about') {
  const viewer = await h.viewer(userId);
  return h.commentsService.orgThread(
    pageId,
    viewer,
    undefined,
    await h.writers.writeStatus(viewer),
  );
}

async function post(
  h: Harness,
  userId: string,
  input: { body: string; parentCommentId?: string; stance?: 'agree' },
  pageId = 'about',
) {
  return h.commentsService.createOnOrgPage(await h.writer(userId), {
    pageId,
    ...input,
  });
}

describe('ORG page targets', () => {
  it('names an ORG page’s thread so it can never be a belief tab', () => {
    expect(orgPageThreadId('about')).toBe(ABOUT);
    expect(orgPageIdOfThread(ABOUT)).toBe('about');
    expect(orgPageIdOfThread('tab_a')).toBeUndefined();
    expect(orgPageIdOfThread(undefined)).toBeUndefined();
    expect(isOrgPageId('membership')).toBe(true);
    expect(isOrgPageId('nope')).toBe(false);
    expect(NOT_AN_ORG_PAGE.$not.test(ABOUT)).toBe(true);
    expect(NOT_AN_ORG_PAGE.$not.test('tab_org-page:x')).toBe(false);
  });
});

describe('OrgPagesService', () => {
  it('reads a published page with its revision and thread id', async () => {
    const h = harness();
    await expect(h.orgPages.find('research')).resolves.toEqual({
      _id: ids.orgResearch,
      pageId: 'research',
      tabId: 'org-page:research',
      revision: 2,
      createdAt: new Date('2026-10-01T09:00:00.000Z'),
    });
    await expect(h.orgPages.forThread('org-page:about')).resolves.toMatchObject(
      { pageId: 'about', revision: 1 },
    );
    await expect(h.orgPages.forThread('tab_a')).resolves.toBeUndefined();
  });

  it('answers the same "not found" for an unknown, unstored or unpublished page', async () => {
    const h = harness();
    for (const pageId of ['nope', 'legal']) {
      const missing = h.orgPages.find(pageId);
      await expect(missing).rejects.toBeInstanceOf(NotFoundException);
      await expect(missing).rejects.toThrow(ORG_PAGE_NOT_FOUND);
    }
    const draftOnly = new OrgPagesService({
      findOne: () => ({
        select: () => ({
          lean: () => ({
            exec: () => Promise.resolve({ _id: ids.orgAbout, pageId: 'about' }),
          }),
        }),
      }),
    } as never);
    await expect(draftOnly.current('about')).resolves.toBeUndefined();
  });

  it('dates a page stored without a creation date at the epoch', async () => {
    const h = harness();
    delete h.pages.docs[0].createdAt;
    await expect(h.orgPages.find('about')).resolves.toMatchObject({
      createdAt: new Date(0),
    });
  });
});

describe('votes on ORG pages', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('shows anyone the counts; a guest is told to sign in', async () => {
    await expect(
      h.votesService.orgPageVotes(await h.viewer(), 'about'),
    ).resolves.toEqual({
      pageId: 'about',
      revision: 1,
      votes: {
        agree: 0,
        disagree: 0,
        earlierWording: 0,
        mayVote: false,
        viewerVoteBlock: 'sign-in',
      },
    });
  });

  it('answers an unknown or unpublished page with the same 404 for every reader, before any voter check', async () => {
    for (const userId of [undefined, U.named, U.anon]) {
      const viewer = await h.viewer(userId);
      await expect(
        h.votesService.castOnOrgPage(viewer, {
          pageId: 'legal',
          value: 'agree',
          baseSeq: 1,
        }),
      ).rejects.toThrow(ORG_PAGE_NOT_FOUND);
      await expect(h.votesService.orgPageVotes(viewer, 'nope')).rejects.toThrow(
        ORG_PAGE_NOT_FOUND,
      );
    }
    await expect(withdraw(h, U.named, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.voteHistory.docs).toHaveLength(0);
  });

  it('casts, changes and withdraws on the published revision, each a chained history entry', async () => {
    await expect(cast(h, U.named, 'agree')).resolves.toEqual({
      pageId: 'about',
      revision: 1,
      votes: {
        agree: 1,
        disagree: 0,
        earlierWording: 0,
        myVote: 'agree',
        mayVote: true,
      },
    });
    // A member page's owner votes on ORG pages like anyone: nobody owns one.
    await cast(h, U.owner, 'agree');
    const changed = await cast(h, U.owner, 'disagree');
    expect(changed.votes).toMatchObject({ agree: 1, disagree: 1 });

    const row = h.votes.docs.find((v) => v.voterUserId === U.named)!;
    expect(row).toMatchObject({ tabId: ABOUT, value: 'agree', textSeq: 1 });
    expect(String(row.profileId)).toBe(String(ids.orgAbout));
    expect(
      h.voteHistory.docs.map((e) => [e.tabId, e.voterUserId, e.action]),
    ).toEqual([
      [ABOUT, U.named, 'cast'],
      [ABOUT, U.owner, 'cast'],
      [ABOUT, U.owner, 'change'],
    ]);
    await expect(
      h.voteHistoryService.verify(ABOUT, U.owner),
    ).resolves.toMatchObject({ valid: true, length: 2 });

    await expect(withdraw(h, U.named)).resolves.toEqual({
      withdrawn: true,
      pageId: 'about',
      revision: 1,
      votes: {
        agree: 0,
        disagree: 1,
        earlierWording: 0,
        mayVote: true,
      },
    });
    // Nothing to take back: no new entry.
    await withdraw(h, U.named);
    expect(h.voteHistory.docs).toHaveLength(4);
  });

  it('never lists an ORG page among the members’ agreed beliefs', async () => {
    await cast(h, U.named, 'agree');
    await cast(h, U.owner, 'agree');
    expect(h.tallies.docs.find((t) => t.tabId === ABOUT)).toMatchObject({
      live: true,
      agreeMember: 2,
      textSeq: 1,
    });
    const list = await h.votesService.agreedPage(await h.viewer(), undefined);
    expect(list.beliefs).toEqual([]);
  });

  it('starts the votes fresh on a new revision, shows the earlier ones apart and lets the voter confirm', async () => {
    await cast(h, U.named, 'agree');
    publish(h, 'about', 2);
    await expect(
      h.votesService.orgPageVotes(await h.viewer(U.named), 'about'),
    ).resolves.toEqual({
      pageId: 'about',
      revision: 2,
      votes: {
        agree: 0,
        disagree: 0,
        earlierWording: 1,
        myVoteOnEarlierWording: 'agree',
        mayVote: true,
      },
    });
    const stale = cast(h, U.named, 'agree', 1);
    await expect(stale).rejects.toBeInstanceOf(ConflictException);
    await expect(stale).rejects.toThrow(ORG_PAGE_VOTE_STALE);

    const confirmed = await cast(h, U.named, 'agree', 2);
    expect(confirmed).toMatchObject({
      revision: 2,
      votes: { agree: 1, earlierWording: 0, myVote: 'agree' },
    });
    expect(h.voteHistory.docs.map((e) => [e.action, e.textSeq])).toEqual([
      ['cast', 1],
      ['confirm', 2],
    ]);
  });

  it('withdraws a vote on an earlier revision too', async () => {
    await cast(h, U.named, 'disagree');
    publish(h, 'about', 3);
    await expect(withdraw(h, U.named)).resolves.toMatchObject({
      withdrawn: true,
      revision: 3,
      votes: { earlierWording: 0 },
    });
    expect(h.voteHistory.docs.at(-1)).toMatchObject({
      action: 'withdraw',
      textSeq: 1,
    });
  });

  it('applies the belief voters’ rule: anonymous by the setting, a member page, a verified email', async () => {
    const refused = cast(h, U.anon, 'agree');
    await expect(refused).rejects.toBeInstanceOf(ForbiddenException);
    await expect(refused).rejects.toThrow(ANONYMOUS_VOTING_OFF);
    await expect(cast(h, U.admin, 'agree')).rejects.toThrow(
      NEEDS_APPROVED_PAGE_TO_VOTE,
    );
    await expect(cast(h, U.waiting, 'agree')).rejects.toThrow(
      NEEDS_APPROVED_PAGE_TO_VOTE,
    );
    await expect(cast(h, U.unverified, 'agree')).rejects.toThrow(
      VERIFY_EMAIL_TO_VOTE,
    );
    await expect(
      h.votesService.orgPageVotes(await h.viewer(U.admin), 'about'),
    ).resolves.toMatchObject({
      votes: { mayVote: false, viewerVoteBlock: 'needs-approved-page' },
    });

    h.settings.anonymous = true;
    await expect(cast(h, U.anon, 'agree')).resolves.toMatchObject({
      votes: { agree: 1, myVote: 'agree' },
    });
    // Kept, but not counted, once the setting is off again.
    h.settings.anonymous = false;
    await expect(
      h.votesService.orgPageVotes(await h.viewer(), 'about'),
    ).resolves.toMatchObject({ votes: { agree: 0 } });
  });

  it('marks the tally not live once the page is no longer published', async () => {
    await cast(h, U.named, 'agree');
    unpublish(h, 'about');
    await h.talliesService.recompute(ABOUT);
    expect(h.tallies.docs.find((t) => t.tabId === ABOUT)).toMatchObject({
      live: false,
      textSeq: 0,
    });
  });
});

describe('comments on ORG pages', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('opens the thread to any reader, offers no rewording suggestions, and keeps it apart from member pages', async () => {
    await expect(orgThread(h)).resolves.toEqual({
      comments: [],
      viewerMayComment: false,
      viewerWriteBlock: 'sign-in',
      viewerMaySuggest: false,
    });
    const made = await post(h, U.named, { body: 'A synthetic thought.' });
    const row = h.comments.docs.find((c) => c.commentId === made.commentId)!;
    expect(row).toMatchObject({ tabId: ABOUT, source: 'native' });
    expect(String(row.profileId)).toBe(String(ids.orgAbout));

    const reply = await post(h, U.owner, {
      body: 'A synthetic reply.',
      parentCommentId: made.commentId,
    });
    const thread = await orgThread(h, U.named);
    expect(thread.viewerMayComment).toBe(true);
    expect(thread.viewerMaySuggest).toBe(false);
    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0]).toMatchObject({
      commentId: made.commentId,
      body: 'A synthetic thought.',
      mine: true,
      author: { kind: 'member', displayName: 'Name of named-writer' },
      replies: [{ commentId: reply.commentId, body: 'A synthetic reply.' }],
    });
    // Another ORG page has its own thread.
    await expect(orgThread(h, U.named, 'research')).resolves.toMatchObject({
      comments: [],
    });
    // A member page's address cannot read it.
    await expect(
      h.commentsService.history('open-page', made.commentId, await h.viewer()),
    ).rejects.toThrow(COMMENT_NOT_FOUND);
  });

  it('edits with versions, shows the history to anyone, and removes softly', async () => {
    const writer = await h.writer(U.named);
    const made = await post(h, U.named, { body: 'First synthetic words.' });
    await expect(
      h.commentsService.edit(writer, made.commentId, 'Second words.', 1),
    ).resolves.toEqual({ changed: true, seq: 2 });
    const history = await h.commentsService.orgHistory('about', made.commentId);
    expect(history.entries.map((e) => [e.seq, e.text])).toEqual([
      [2, 'Second words.'],
      [1, 'First synthetic words.'],
    ]);
    await expect(
      h.commentsService.orgHistory('research', made.commentId),
    ).rejects.toThrow(COMMENT_NOT_FOUND);

    await expect(
      h.commentsService.remove(U.named, made.commentId),
    ).resolves.toEqual({ removed: true });
    const thread = await orgThread(h);
    expect(thread.comments[0]).toMatchObject({ removed: true });
    expect(thread.comments[0]).not.toHaveProperty('body');
  });

  it('names authors by the Chunk 9 rule: "ORG admin", and no name a reader may not see', async () => {
    await post(h, U.admin, { body: 'From an admin, synthetically.' });
    await post(h, U.anon, { body: 'From a members-only page.' });
    await post(h, U.hiddenOwner, { body: 'From an unlisted page.' });
    const guest = await orgThread(h);
    // A members-only page's name is shown to guests, its link is not; an
    // unlisted page's name is not shown at all.
    expect(guest.comments.map((c) => c.author)).toEqual([
      { kind: 'admin' },
      { kind: 'member', displayName: 'Name of anon-writer' },
      { kind: 'member' },
    ]);
    const member = await orgThread(h, U.named);
    expect(member.comments[1].author).toEqual({
      kind: 'member',
      displayName: 'Name of anon-writer',
      slug: 'anon-writer',
    });
  });

  it('refuses writers the belief threads refuse, and unknown pages first', async () => {
    await expect(h.writer(U.nopage)).rejects.toBeInstanceOf(ForbiddenException);
    const writer = await h.writer(U.named);
    for (const pageId of ['nope', 'legal']) {
      await expect(
        h.commentsService.createOnOrgPage(writer, {
          pageId,
          body: 'Lost words.',
        }),
      ).rejects.toThrow(ORG_PAGE_NOT_FOUND);
    }
    await expect(
      h.commentsService.createOnOrgPage(writer, { pageId: 'nope', body: ' ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(orgThread(h, undefined, 'nope')).rejects.toThrow(
      ORG_PAGE_NOT_FOUND,
    );
    await expect(h.commentsService.orgHistory('nope', 'cmt_x')).rejects.toThrow(
      ORG_PAGE_NOT_FOUND,
    );
  });

  it('stops edits once the page is no longer published', async () => {
    const writer = await h.writer(U.named);
    const made = await post(h, U.named, { body: 'Words before.' });
    unpublish(h, 'about');
    await expect(
      h.commentsService.edit(writer, made.commentId, 'Words after.', 1),
    ).rejects.toThrow(COMMENT_NOT_FOUND);
  });

  it('gives a stance badge only for a vote on the current revision', async () => {
    const noVote = post(h, U.named, { body: 'Agrees?', stance: 'agree' });
    await expect(noVote).rejects.toBeInstanceOf(ConflictException);
    await expect(noVote).rejects.toThrow(STANCE_NEEDS_PAGE_VOTE);

    await cast(h, U.named, 'disagree');
    await expect(
      post(h, U.named, { body: 'Agrees?', stance: 'agree' }),
    ).rejects.toThrow(stanceOtherVote('disagree', 'page'));
    expect(stanceOtherVote('disagree', 'page')).toContain('this page');

    const writer = await h.writer(U.named);
    const made = await h.commentsService.createOnOrgPage(writer, {
      pageId: 'about',
      body: 'Why I disagree, synthetically.',
      stance: 'disagree',
    });
    expect((await orgThread(h)).comments[0]).toMatchObject({
      commentId: made.commentId,
      stance: 'disagree',
    });
    await expect(
      h.commentsService.createOnOrgPage(writer, {
        pageId: 'about',
        body: 'A reply cannot say.',
        parentCommentId: made.commentId,
        stance: 'disagree',
      }),
    ).rejects.toThrow(STANCE_ONLY_ON_BELIEF);

    publish(h, 'about', 2);
    await expect(
      h.commentsService.createOnOrgPage(writer, {
        pageId: 'about',
        body: 'Still disagree.',
        stance: 'disagree',
      }),
    ).rejects.toThrow(STANCE_EARLIER_VERSION);
  });
});
