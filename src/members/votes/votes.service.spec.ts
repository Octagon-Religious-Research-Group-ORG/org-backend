import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { VOTE_BUSY } from '../../social/vote-history.service';
import {
  harness,
  type Harness,
  ids,
  U,
} from '../comments/comments-harness.mocks-spec';
import { REMOVAL_BUSY } from '../member-page-editor.service';
import type { FullProfile } from '../profile-serializers';
import { TEXT_TURN_STALE_MS } from '../tab-text-turns';
import {
  ANONYMOUS_VOTING_OFF,
  NEEDS_APPROVED_PAGE_TO_VOTE,
  OWN_BELIEF,
  PAGE_NOT_OPEN,
  VERIFY_EMAIL_TO_VOTE,
} from './voters.service';
import {
  AGREED_BATCH,
  AGREED_MAX_SCAN,
  AGREED_PAGE_SIZE,
  parseCursor,
  tabVotes,
  VOTE_STALE,
} from './votes.service';

/** Every name and text here is synthetic. */

/** Adds an approved member page for a new voter. */
function addMember(
  h: Harness,
  userId: string,
  extra: Record<string, unknown> = {},
) {
  h.profiles.docs.push({
    _id: new Types.ObjectId(),
    slug: `page-of-${userId.replace(/_/g, '-')}`,
    displayName: `Name of ${userId}`,
    visibility: 'public',
    reviewStatus: 'approved',
    anonymous: false,
    ownerUserId: userId,
    imageIds: [],
    contacts: [],
    ...extra,
  });
}

async function cast(
  h: Harness,
  userId: string,
  slug: string,
  tabId: string,
  value: 'agree' | 'disagree',
  baseSeq = 1,
) {
  return h.votesService.cast(await h.viewer(userId), {
    slug,
    tabId,
    value,
    baseSeq,
  });
}

/** Removal turns need `$expr`, which the in-memory model lacks. */
function allowRemovals(h: Harness) {
  Object.assign(h.profiles.docs.find((p) => p.slug === 'open-page')!, {
    liveTabCount: 2,
    nextTabOrder: 3,
  });
  jest
    .spyOn(
      h.editor as unknown as { takeRemovalTurn: () => Promise<unknown> },
      'takeRemovalTurn',
    )
    .mockResolvedValue({ id: 'turn' });
}

async function pageVotes(h: Harness, slug: string, userId?: string) {
  const viewer = await h.viewer(userId);
  const view = (await h.votesService.withVotes(
    await h.members.profile(slug, viewer),
    viewer,
  )) as FullProfile;
  return Object.fromEntries(view.tabs.map((tab) => [tab.tabId, tab.votes]));
}

describe('VotesService', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  describe('casting', () => {
    it('casts, changes, confirms nothing new and withdraws, each a chained history entry', async () => {
      await expect(
        cast(h, U.named, 'open-page', 'tab_a', 'agree'),
      ).resolves.toEqual({
        tabId: 'tab_a',
        textSeq: 1,
        votes: {
          agree: 1,
          disagree: 0,
          earlierWording: 0,
          myVote: 'agree',
          mayVote: true,
        },
      });
      // The same vote again writes nothing.
      await cast(h, U.named, 'open-page', 'tab_a', 'agree');
      expect(h.voteHistory.docs).toHaveLength(1);

      const changed = await cast(h, U.named, 'open-page', 'tab_a', 'disagree');
      expect(changed.votes).toMatchObject({
        agree: 0,
        disagree: 1,
        myVote: 'disagree',
      });
      await expect(
        h.votesService.withdraw(
          { ...(await h.viewer(U.named)), userId: U.named },
          'OPEN-PAGE',
          'tab_a',
        ),
      ).resolves.toMatchObject({
        withdrawn: true,
        votes: { agree: 0, disagree: 0, mayVote: true },
      });
      expect(h.voteHistory.docs.map((e) => [e.seq, e.action, e.value])).toEqual(
        [
          [1, 'cast', 'agree'],
          [2, 'change', 'disagree'],
          [3, 'withdraw', undefined],
        ],
      );
      await expect(
        h.voteHistoryService.verify('tab_a', U.named),
      ).resolves.toMatchObject({ valid: true, length: 3 });
      expect(h.votes.docs).toHaveLength(1);
      expect(h.votes.docs[0]).toMatchObject({ historySeq: 3 });
      expect(h.votes.docs[0].value).toBeUndefined();
      expect(h.votes.docs[0].pending).toBeUndefined();

      // Withdrawing nothing is no error and writes nothing.
      await h.votesService.withdraw(
        { ...(await h.viewer(U.named)), userId: U.named },
        'open-page',
        'tab_a',
      );
      expect(h.voteHistory.docs).toHaveLength(3);
      // A cast after a withdrawal is a cast again.
      await cast(h, U.named, 'open-page', 'tab_a', 'agree');
      expect(h.voteHistory.docs.at(-1)).toMatchObject({ action: 'cast' });
    });

    it('records the tier and refreshes it on the next vote', async () => {
      await cast(h, U.named, 'open-page', 'tab_a', 'agree');
      expect(h.votes.docs[0].voterTier).toBe('member');
      h.settings.anonymous = true;
      h.profiles.docs.find((p) => p.ownerUserId === U.named)!.anonymous = true;
      await cast(h, U.named, 'open-page', 'tab_a', 'agree');
      expect(h.votes.docs[0].voterTier).toBe('anonymous');
      expect(h.voteHistory.docs.at(-1)).toMatchObject({
        action: 'confirm',
        voterTier: 'anonymous',
      });
    });

    it.each([
      [U.admin, NEEDS_APPROVED_PAGE_TO_VOTE],
      [U.nopage, NEEDS_APPROVED_PAGE_TO_VOTE],
      [U.waiting, NEEDS_APPROVED_PAGE_TO_VOTE],
      [U.anon, ANONYMOUS_VOTING_OFF],
      [U.unverified, VERIFY_EMAIL_TO_VOTE],
      [U.owner, OWN_BELIEF],
    ])('refuses %s', async (userId, message) => {
      const refused = cast(h, userId, 'open-page', 'tab_a', 'agree');
      await expect(refused).rejects.toBeInstanceOf(ForbiddenException);
      await expect(refused).rejects.toThrow(message);
      expect(h.votes.docs).toHaveLength(0);
    });

    it('reads a page with no review status as approved, and still ends the turn when ending it fails', async () => {
      delete h.profiles.docs.find((p) => p.slug === 'open-page')!.reviewStatus;
      const real = h.tabs.updateOne;
      h.tabs.updateOne = (filter, change, options) =>
        '$pull' in change && !('textTurns.at' in filter)
          ? { exec: () => Promise.reject(new Error('turn store down')) }
          : real(filter, change, options);
      await expect(
        cast(h, U.named, 'open-page', 'tab_a', 'agree'),
      ).resolves.toMatchObject({ votes: { agree: 1 } });
      h.tabs.updateOne = real;
      await cast(h, 'user_admin_paged', 'open-page', 'tab_a', 'agree');
      const page = await h.votesService.agreedPage(await h.viewer(), undefined);
      expect(page.beliefs.map((b) => b.tabId)).toEqual(['tab_a']);
    });

    it('lets an admin with an approved page of their own vote as a member', async () => {
      await cast(h, U.adminWithPage, 'open-page', 'tab_a', 'agree');
      expect(h.votes.docs[0]).toMatchObject({ voterTier: 'member' });
    });

    it('lets anonymous members vote while the setting is on', async () => {
      h.settings.anonymous = true;
      const out = await cast(h, U.anon, 'open-page', 'tab_a', 'agree');
      expect(out.votes).toMatchObject({ agree: 1, myVote: 'agree' });
      expect(h.votes.docs[0].voterTier).toBe('anonymous');
    });

    it('allows votes on an unclaimed imported page', async () => {
      const out = await cast(h, U.named, 'imported-page', 'tab_i', 'agree');
      expect(out.votes).toMatchObject({ agree: 1 });
    });

    it('refuses a page not approved, even to someone who can open it', async () => {
      // An admin with a page can open a pending page.
      const refused = cast(
        h,
        U.adminWithPage,
        'waiting-page',
        'tab_w',
        'agree',
      );
      await expect(refused).rejects.toThrow(PAGE_NOT_OPEN);
    });

    it.each([
      ['a page the voter may not read', 'hidden-page', 'tab_h'],
      ['a removed belief', 'open-page', 'tab_removed'],
      ['another page’s belief', 'open-page', 'tab_m'],
      ['a page that does not exist', 'no-such-page', 'tab_a'],
    ])('answers 404 for %s', async (_name, slug, tabId) => {
      await expect(
        cast(h, U.named, slug, tabId, 'agree'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(h.votes.docs).toHaveLength(0);
    });

    it('answers 404 on a members-only page to a reader who sees only its name', async () => {
      h.profiles.docs.find((p) => p.slug === 'members-page')!.visibility =
        'named-members';
      h.settings.anonymous = true;
      await expect(
        cast(h, U.anon, 'members-page', 'tab_m', 'agree'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses a vote on a wording the voter did not see (409), and lets the turn go', async () => {
      const stale = cast(h, U.named, 'open-page', 'tab_a', 'agree', 7);
      await expect(stale).rejects.toBeInstanceOf(ConflictException);
      await expect(stale).rejects.toThrow(VOTE_STALE);
      const tab = h.tabs.docs.find((t) => t.tabId === 'tab_a')!;
      expect(tab.textTurns).toEqual([]);
      // Nothing written, and the tally is left clean.
      expect(h.tallies.docs[0].dirtySince).toBeUndefined();
    });

    it('is refused as busy while another window holds the row', async () => {
      await cast(h, U.named, 'open-page', 'tab_a', 'agree');
      h.votes.docs[0].pending = { seq: 2, at: new Date(), textSeq: 1 };
      await expect(
        cast(h, U.named, 'open-page', 'tab_a', 'disagree'),
      ).rejects.toThrow(VOTE_BUSY);
    });

    it('never makes two votes from a double click', async () => {
      const both = await Promise.allSettled([
        cast(h, U.named, 'open-page', 'tab_a', 'agree'),
        cast(h, U.named, 'open-page', 'tab_a', 'agree'),
      ]);
      expect(h.votes.docs).toHaveLength(1);
      expect(h.voteHistory.docs).toHaveLength(1);
      const refused = both.filter((r) => r.status === 'rejected');
      for (const r of refused) {
        expect(r.reason).toBeInstanceOf(ConflictException);
      }
      expect((await pageVotes(h, 'open-page')).tab_a).toMatchObject({
        agree: 1,
      });
    });

    it('refuses as busy when a claim is lost between read and update', async () => {
      await cast(h, U.named, 'open-page', 'tab_a', 'agree');
      const real = h.votes.updateOne;
      let first = true;
      h.votes.updateOne = (filter, change, options) => {
        if (first && 'pending' in (filter as object)) {
          first = false;
          // Another window claims it first.
          h.votes.docs[0].pending = { seq: 2, at: new Date() };
        }
        return real(filter, change, options);
      };
      await expect(
        cast(h, U.named, 'open-page', 'tab_a', 'disagree'),
      ).rejects.toThrow(VOTE_BUSY);
    });

    it('rethrows a failure to create the row, unchanged', async () => {
      const failing = harness({
        votes: (operation) => {
          if (operation === 'create') throw new Error('disk full');
        },
      });
      await expect(
        cast(failing, U.named, 'open-page', 'tab_a', 'agree'),
      ).rejects.toThrow('disk full');
    });

    it('releases the claim when the history cannot be written, and counts nothing', async () => {
      const failing = harness({
        voteHistory: () => {
          throw new Error('history down');
        },
      });
      await expect(
        cast(failing, U.named, 'open-page', 'tab_a', 'agree'),
      ).rejects.toThrow('history down');
      expect(failing.votes.docs[0].pending).toBeUndefined();
      expect(failing.votes.docs[0].value).toBeUndefined();
      expect((await pageVotes(failing, 'open-page')).tab_a).toMatchObject({
        agree: 0,
      });
    });

    it('catches the row up to a history entry written by a write that died', async () => {
      await cast(h, U.named, 'open-page', 'tab_a', 'agree');
      // A write that recorded seq 2 and died before confirming the row.
      await h.voteHistoryService.append({
        tabId: 'tab_a',
        voterUserId: U.named,
        action: 'change',
        value: 'disagree',
        textSeq: 1,
        voterTier: 'member',
        expectedSeq: 1,
      });
      // Same as the row, but not as the record: the row is caught up first,
      // so this is a change, not "nothing new".
      await cast(h, U.named, 'open-page', 'tab_a', 'agree');
      expect(h.votes.docs[0]).toMatchObject({ value: 'agree', historySeq: 3 });
      expect(h.voteHistory.docs.at(-1)).toMatchObject({
        seq: 3,
        action: 'change',
      });
      await expect(
        h.voteHistoryService.verify('tab_a', U.named),
      ).resolves.toMatchObject({ valid: true, length: 3 });
    });
  });

  describe('repairing writes that stopped part-way', () => {
    const old = () => new Date(Date.now() - TEXT_TURN_STALE_MS - 1000);

    it('drops a stale claim whose entry never landed', async () => {
      await cast(h, U.named, 'open-page', 'tab_a', 'agree');
      h.votes.docs[0].pending = {
        seq: 2,
        value: 'disagree',
        textSeq: 1,
        voterTier: 'member',
        at: old(),
      };
      await cast(h, U.named, 'open-page', 'tab_b', 'agree');
      expect(h.votes.docs[0].pending).toBeUndefined();
      expect(h.votes.docs[0]).toMatchObject({ value: 'agree', historySeq: 1 });
    });

    it('confirms a stale claim whose entry landed, and recounts', async () => {
      await cast(h, U.named, 'open-page', 'tab_a', 'agree');
      await h.voteHistoryService.append({
        tabId: 'tab_a',
        voterUserId: U.named,
        action: 'withdraw',
        textSeq: 1,
        voterTier: 'member',
        expectedSeq: 1,
      });
      h.votes.docs[0].pending = {
        seq: 2,
        textSeq: 1,
        voterTier: 'member',
        at: old(),
      };
      await h.votesService.repair(U.named);
      expect(h.votes.docs[0].value).toBeUndefined();
      expect(h.votes.docs[0].historySeq).toBe(2);
      expect((await pageVotes(h, 'open-page')).tab_a).toMatchObject({
        agree: 0,
      });
    });

    it('never fails a vote because the repair failed', async () => {
      const real = h.votes.find;
      h.votes.find = (filter) => {
        if (filter && 'pending.at' in filter) throw new Error('read failed');
        return real(filter);
      };
      await expect(
        cast(h, U.named, 'open-page', 'tab_a', 'agree'),
      ).resolves.toMatchObject({ votes: { agree: 1 } });
    });
  });

  describe('wording changes', () => {
    it('keeps votes on an earlier wording uncounted until confirmed', async () => {
      addMember(h, 'user_voter2');
      await cast(h, U.named, 'open-page', 'tab_a', 'agree');
      await cast(h, 'user_voter2', 'open-page', 'tab_a', 'disagree');
      await h.editor.editTabText(
        U.owner,
        'tab_a',
        'A new synthetic wording.',
        1,
      );

      expect((await pageVotes(h, 'open-page', U.named)).tab_a).toEqual({
        agree: 0,
        disagree: 0,
        earlierWording: 2,
        myVoteOnEarlierWording: 'agree',
        mayVote: true,
      });
      // "Confirm my vote on the new wording".
      const confirmed = await cast(
        h,
        U.named,
        'open-page',
        'tab_a',
        'agree',
        2,
      );
      expect(confirmed.votes).toEqual({
        agree: 1,
        disagree: 0,
        earlierWording: 1,
        myVote: 'agree',
        mayVote: true,
      });
      expect(h.voteHistory.docs.at(-1)).toMatchObject({
        action: 'confirm',
        textSeq: 2,
      });
      // The old wording is now refused.
      await expect(
        cast(h, 'user_voter2', 'open-page', 'tab_a', 'disagree', 1),
      ).rejects.toThrow(VOTE_STALE);
    });

    it('treats an accepted rewording suggestion as a new wording', async () => {
      await cast(h, U.named, 'open-page', 'tab_a', 'agree');
      const writer = await h.writer(U.named);
      const made = await h.suggestions.suggest(writer, {
        slug: 'open-page',
        tabId: 'tab_a',
        text: 'A suggested synthetic wording.',
        baseSeq: 1,
      });
      await h.suggestions.accept(U.owner, made.commentId);
      expect((await pageVotes(h, 'open-page')).tab_a).toMatchObject({
        agree: 0,
        earlierWording: 1,
      });
    });

    it('recounts a tally an edit left behind when the page is read', async () => {
      await cast(h, U.named, 'open-page', 'tab_a', 'agree');
      // An edit whose recount never ran: the version landed, the tally did not.
      const tally = h.tallies.docs.find((t) => t.tabId === 'tab_a')!;
      tally.textSeq = 0;
      expect((await pageVotes(h, 'open-page')).tab_a).toMatchObject({
        agree: 1,
      });
      expect(tally.textSeq).toBe(1);
    });

    it('withdraws a vote on a belief removed since, and keeps it out of every count', async () => {
      allowRemovals(h);
      await cast(h, U.named, 'open-page', 'tab_a', 'agree');
      await h.editor.removeTab(U.owner, 'tab_a');
      expect(h.tallies.docs.find((t) => t.tabId === 'tab_a')).toMatchObject({
        live: false,
        agreeMember: 1,
      });
      await expect(
        h.votesService.withdraw(
          { ...(await h.viewer(U.named)), userId: U.named },
          'open-page',
          'tab_a',
        ),
      ).resolves.toEqual({ withdrawn: true });
      expect(h.votes.docs[0].value).toBeUndefined();
    });

    it('cannot remove a belief while a vote holds its turn', async () => {
      allowRemovals(h);
      h.tabs.docs.find((t) => t.tabId === 'tab_a')!.textTurns = [
        { id: 'vote-turn', at: new Date() },
      ];
      await expect(h.editor.removeTab(U.owner, 'tab_a')).rejects.toThrow(
        REMOVAL_BUSY,
      );
      // The removal's own tally marks are cleared again.
      expect(
        h.tallies.docs.find((t) => t.tabId === 'tab_a')?.dirtySince,
      ).toBeUndefined();
    });
  });

  describe('withdrawing', () => {
    const withdraw = async (userId: string, slug: string, tabId: string) =>
      h.votesService.withdraw(
        { ...(await h.viewer(userId)), userId },
        slug,
        tabId,
      );

    it('needs no right to vote now', async () => {
      h.settings.anonymous = true;
      await cast(h, U.anon, 'open-page', 'tab_a', 'agree');
      h.settings.anonymous = false;
      await expect(
        withdraw(U.anon, 'open-page', 'tab_a'),
      ).resolves.toMatchObject({
        votes: { viewerVoteBlock: 'anonymous-off', mayVote: false },
      });
      expect(h.votes.docs[0].value).toBeUndefined();
    });

    it('answers without the belief when the reader may no longer read the page', async () => {
      await cast(h, U.named, 'members-page', 'tab_m', 'agree');
      h.profiles.docs.find((p) => p.slug === 'members-page')!.visibility =
        'unlisted';
      await expect(withdraw(U.named, 'members-page', 'tab_m')).resolves.toEqual(
        { withdrawn: true },
      );
      expect(h.votes.docs[0].value).toBeUndefined();
    });

    it('answers without the belief when the reader sees only the name', async () => {
      await cast(h, U.named, 'members-page', 'tab_m', 'agree');
      h.profiles.docs.find((p) => p.slug === 'members-page')!.visibility =
        'named-members';
      h.profiles.docs.find((p) => p.ownerUserId === U.named)!.anonymous = true;
      await expect(withdraw(U.named, 'members-page', 'tab_m')).resolves.toEqual(
        { withdrawn: true },
      );
    });

    it('does not touch a vote named under another page', async () => {
      await cast(h, U.named, 'members-page', 'tab_m', 'agree');
      await withdraw(U.named, 'open-page', 'tab_m');
      expect(h.votes.docs[0].value).toBe('agree');
    });

    it('answers 404 for a page that does not exist', async () => {
      await expect(
        withdraw(U.named, 'no-such-page', 'tab_a'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('counts on a page', () => {
    it('counts anonymous votes only while the setting is on, keeping them either way', async () => {
      h.settings.anonymous = true;
      await cast(h, U.anon, 'open-page', 'tab_a', 'agree');
      await cast(h, U.named, 'open-page', 'tab_a', 'disagree');
      expect((await pageVotes(h, 'open-page')).tab_a).toMatchObject({
        agree: 1,
        disagree: 1,
      });
      h.settings.anonymous = false;
      expect((await pageVotes(h, 'open-page')).tab_a).toMatchObject({
        agree: 0,
        disagree: 1,
      });
      expect(h.votes.docs).toHaveLength(2);
    });

    it('tells each reader why the buttons are off', async () => {
      const block = async (userId?: string) =>
        (await pageVotes(h, 'open-page', userId)).tab_a?.viewerVoteBlock;
      await expect(block()).resolves.toBe('sign-in');
      await expect(block(U.nopage)).resolves.toBe('needs-approved-page');
      await expect(block(U.admin)).resolves.toBe('needs-approved-page');
      await expect(block(U.anon)).resolves.toBe('anonymous-off');
      await expect(block(U.unverified)).resolves.toBe('verify-email');
      await expect(block(U.owner)).resolves.toBe('own-belief');
      await expect(block(U.named)).resolves.toBeUndefined();
      await expect(block('user_fresh')).resolves.toBe('needs-approved-page');
      addMember(h, 'user_fresh');
      h.clerk.getIdentity.mockRejectedValueOnce(new Error('Clerk down'));
      await expect(block('user_fresh')).resolves.toBe('cannot-check');
    });

    it('tells the owner of a pending page they need an approved page first', async () => {
      const votes = await pageVotes(h, 'waiting-page', U.waiting);
      expect(votes.tab_w).toMatchObject({
        viewerVoteBlock: 'needs-approved-page',
        agree: 0,
      });
    });

    it('leaves a name-only page as it is', async () => {
      h.profiles.docs.find((p) => p.slug === 'members-page')!.visibility =
        'named-members';
      const viewer = await h.viewer();
      const view = await h.members.profile('members-page', viewer);
      await expect(h.votesService.withVotes(view, viewer)).resolves.toBe(view);
    });
  });

  describe('the Beliefs page list', () => {
    const list = async (userId?: string, after?: string) =>
      h.votesService.agreedPage(await h.viewer(userId), after);

    beforeEach(() => {
      for (const id of ['user_v1', 'user_v2', 'user_v3']) addMember(h, id);
    });

    it('lists beliefs with 2+ current-wording agrees, disagrees shown, most agrees first', async () => {
      await cast(h, 'user_v1', 'open-page', 'tab_a', 'agree');
      await cast(h, 'user_v2', 'open-page', 'tab_a', 'agree');
      await cast(h, 'user_v3', 'open-page', 'tab_a', 'disagree');
      await cast(h, 'user_v1', 'open-page', 'tab_b', 'agree');
      await cast(h, 'user_v2', 'open-page', 'tab_b', 'agree');
      await cast(h, 'user_v3', 'open-page', 'tab_b', 'agree');
      await cast(h, 'user_v1', 'imported-page', 'tab_i', 'agree');

      const page = await list(undefined);
      expect(page.nextAfter).toBeUndefined();
      expect(page.beliefs.map((b) => [b.tabId, b.votes.agree])).toEqual([
        ['tab_b', 3],
        ['tab_a', 2],
      ]);
      expect(page.beliefs[1]).toEqual({
        slug: 'open-page',
        tabId: 'tab_a',
        title: 'Title tab_a',
        paragraphs: [
          {
            blockId: 'blk_a1',
            kind: 'paragraph',
            label: '',
            text: 'Synthetic belief A.',
          },
        ],
        textSeq: 1,
        author: { displayName: 'Name of open-page', slug: 'open-page' },
        votes: {
          agree: 2,
          disagree: 1,
          earlierWording: 0,
          mayVote: false,
          viewerVoteBlock: 'sign-in',
        },
      });
      expect(JSON.stringify(page)).not.toMatch(/user_|voterUserId|profileId/);
    });

    it('breaks ties newest belief first', async () => {
      h.tabs.docs.find((t) => t.tabId === 'tab_a')!.createdAt = new Date(1000);
      h.tabs.docs.find((t) => t.tabId === 'tab_b')!.createdAt = new Date(2000);
      for (const tab of ['tab_a', 'tab_b']) {
        await cast(h, 'user_v1', 'open-page', tab, 'agree');
        await cast(h, 'user_v2', 'open-page', tab, 'agree');
      }
      expect((await list()).beliefs.map((b) => b.tabId)).toEqual([
        'tab_b',
        'tab_a',
      ]);
    });

    it('shows each reader only the pages they may read, and their own vote', async () => {
      await cast(h, 'user_v1', 'members-page', 'tab_m', 'agree');
      await cast(h, 'user_v2', 'members-page', 'tab_m', 'agree');
      expect((await list()).beliefs).toEqual([]);
      const forMember = await list('user_v1');
      expect(forMember.beliefs.map((b) => b.tabId)).toEqual(['tab_m']);
      expect(forMember.beliefs[0].votes).toMatchObject({
        myVote: 'agree',
        mayVote: true,
      });
      const forOwner = await list(U.membersOwner);
      expect(forOwner.beliefs[0].votes.viewerVoteBlock).toBe('own-belief');
    });

    it('leaves out deleted, pending and unlisted pages, and removed beliefs', async () => {
      await cast(h, 'user_v1', 'open-page', 'tab_a', 'agree');
      await cast(h, 'user_v2', 'open-page', 'tab_a', 'agree');
      await cast(h, 'user_v1', 'open-page', 'tab_b', 'agree');
      await cast(h, 'user_v2', 'open-page', 'tab_b', 'agree');
      expect((await list()).beliefs).toHaveLength(2);
      h.tabs.docs.find((t) => t.tabId === 'tab_b')!.removedAt = new Date();
      expect((await list()).beliefs.map((b) => b.tabId)).toEqual(['tab_a']);
      const page = h.profiles.docs.find((p) => p.slug === 'open-page')!;
      page.reviewStatus = 'pending';
      expect((await list(U.admin)).beliefs).toEqual([]);
      page.reviewStatus = 'approved';
      page.visibility = 'unlisted';
      expect((await list()).beliefs).toEqual([]);
      page.visibility = 'public';
      page.deletedAt = new Date();
      expect((await list(U.admin)).beliefs).toEqual([]);
    });

    it('drops a belief whose agrees fall below 2 (withdrawn, or reworded)', async () => {
      await cast(h, 'user_v1', 'open-page', 'tab_a', 'agree');
      await cast(h, 'user_v2', 'open-page', 'tab_a', 'agree');
      expect((await list()).beliefs).toHaveLength(1);
      await h.votesService.withdraw(
        { ...(await h.viewer('user_v2')), userId: 'user_v2' },
        'open-page',
        'tab_a',
      );
      expect((await list()).beliefs).toEqual([]);
      await cast(h, 'user_v2', 'open-page', 'tab_a', 'agree');
      await h.editor.editTabText(
        U.owner,
        'tab_a',
        'Reworded synthetic belief.',
        1,
      );
      expect((await list()).beliefs).toEqual([]);
    });

    it('recounts a stale tally before listing it, and drops it if it no longer qualifies', async () => {
      await cast(h, 'user_v1', 'open-page', 'tab_a', 'agree');
      await cast(h, 'user_v2', 'open-page', 'tab_a', 'agree');
      // A wording change whose recount never ran.
      await h.versions.create({
        blockId: 'blk_a1',
        seq: 2,
        text: 'Changed under the tally.',
        authorUserId: U.owner,
        createdAt: new Date(),
        prevHash: '0'.repeat(64),
        hash: '1'.repeat(64),
      });
      expect((await list()).beliefs).toEqual([]);
      expect(h.tallies.docs.find((t) => t.tabId === 'tab_a')).toMatchObject({
        textSeq: 2,
        agreeMember: 0,
        earlierMember: 2,
      });
    });

    it('recounts a dirty tally that still qualifies and lists it', async () => {
      await cast(h, 'user_v1', 'open-page', 'tab_a', 'agree');
      await cast(h, 'user_v2', 'open-page', 'tab_a', 'agree');
      h.tallies.docs.find((t) => t.tabId === 'tab_a')!.dirtySince = new Date();
      expect((await list()).beliefs.map((b) => b.tabId)).toEqual(['tab_a']);
    });

    it('counts anonymous agrees only while the setting is on', async () => {
      h.settings.anonymous = true;
      await cast(h, 'user_v1', 'open-page', 'tab_a', 'agree');
      await cast(h, U.anon, 'open-page', 'tab_a', 'agree');
      expect((await list()).beliefs).toHaveLength(1);
      h.settings.anonymous = false;
      expect((await list()).beliefs).toEqual([]);
    });

    it('pages by cursor, and stops after a bounded scan', async () => {
      // Many qualifying beliefs on one public page.
      const profileId = ids.open;
      const tabIds = Array.from(
        { length: AGREED_MAX_SCAN + 5 },
        (_, i) => `tab_p${String(i).padStart(3, '0')}`,
      );
      for (const [i, tabId] of tabIds.entries()) {
        h.tabs.docs.push({
          _id: new Types.ObjectId(),
          profileId,
          tabId,
          title: `Title ${tabId}`,
          order: 10 + i,
          reviewStatus: 'confirmed',
          createdAt: new Date(10_000 + i),
        });
        h.tallies.docs.push({
          _id: new Types.ObjectId(),
          tabId,
          profileId,
          rev: 1,
          live: true,
          textSeq: 0,
          agreeMember: 2,
          agreeAnon: 0,
          disagreeMember: 0,
          disagreeAnon: 0,
          earlierMember: 0,
          earlierAnon: 0,
          agreeAll: 2,
          tabCreatedAt: new Date(10_000 + i),
        });
      }
      const first = await list();
      expect(first.beliefs).toHaveLength(AGREED_PAGE_SIZE);
      expect(first.beliefs[0].tabId).toBe(tabIds.at(-1));
      const second = await list(undefined, first.nextAfter);
      expect(second.beliefs[0].tabId).toBe(tabIds.at(-1 - AGREED_PAGE_SIZE));
      const seen = new Set(
        [...first.beliefs, ...second.beliefs].map((b) => b.tabId),
      );
      expect(seen.size).toBe(2 * AGREED_PAGE_SIZE);

      // A reader who may read none of them: the scan stops at the bound.
      h.profiles.docs.find((p) => p.slug === 'open-page')!.visibility =
        'members';
      const bounded = await list();
      expect(bounded.beliefs).toEqual([]);
      expect(bounded.nextAfter).toBeDefined();
      expect(parseCursor(String(bounded.nextAfter))).toMatchObject({
        agrees: 2,
        tabId: tabIds.at(-AGREED_MAX_SCAN),
      });
      // Carries on to the end.
      const rest = await list(undefined, bounded.nextAfter);
      expect(rest.beliefs).toEqual([]);
      expect(rest.nextAfter).toBeUndefined();
    });

    it('ends without a cursor when the page fills on the last row', async () => {
      const profileId = ids.open;
      for (let i = 0; i < AGREED_PAGE_SIZE; i++) {
        const tabId = `tab_q${i}`;
        h.tabs.docs.push({
          _id: new Types.ObjectId(),
          profileId,
          tabId,
          title: tabId,
          order: 20 + i,
          reviewStatus: 'confirmed',
        });
        h.tallies.docs.push({
          _id: new Types.ObjectId(),
          tabId,
          profileId,
          rev: 0,
          live: true,
          textSeq: 0,
          agreeMember: 3,
          agreeAll: 3,
        });
      }
      const page = await list();
      expect(page.beliefs).toHaveLength(AGREED_PAGE_SIZE);
      expect(page.nextAfter).toBeUndefined();
      expect(AGREED_PAGE_SIZE).toBeLessThan(AGREED_BATCH);
    });

    it('repairs tallies a writer left dirty', async () => {
      await cast(h, 'user_v1', 'open-page', 'tab_a', 'agree');
      await cast(h, 'user_v2', 'open-page', 'tab_a', 'agree');
      const tally = h.tallies.docs.find((t) => t.tabId === 'tab_a')!;
      tally.agreeMember = 0;
      tally.agreeAll = 0;
      tally.dirtySince = new Date(0);
      expect((await list()).beliefs.map((b) => b.tabId)).toEqual(['tab_a']);
      expect(tally.dirtySince).toBeUndefined();
    });

    it('refuses a cursor it did not make', async () => {
      await expect(list(undefined, 'not a cursor')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  it('builds one belief’s state from its parts', () => {
    expect(
      tabVotes(
        undefined,
        3,
        { value: 'agree', textSeq: 2 },
        { mayVote: true },
        false,
      ),
    ).toEqual({
      agree: 0,
      disagree: 0,
      earlierWording: 0,
      myVoteOnEarlierWording: 'agree',
      mayVote: true,
    });
  });

  it('answers 503 when the account cannot be checked', async () => {
    h.clerk.getIdentity.mockRejectedValueOnce(new Error('Clerk down'));
    await expect(
      cast(h, 'user_named', 'open-page', 'tab_a', 'agree'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
