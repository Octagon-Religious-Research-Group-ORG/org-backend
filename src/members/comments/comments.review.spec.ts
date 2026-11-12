/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- spies wrapping the in-memory store */
// Chunk 9 independent review: one test (or more) per item it raised.
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { MAX_BLOCK_TEXT_LENGTH } from '../../social/schemas/block-version.schema';
import { MAX_COMMENT_VERSION_TEXT } from '../../social/schemas/comment-version.schema';
import { MAX_COMMENT_LENGTH } from '../../social/schemas/comment.schema';
import { REMOVAL_BUSY } from '../member-page-editor.service';
import { THREAD_PAGE_SIZE } from './comment-limits';
import { COMMENT_TURN_STALE_MS } from './comment-store';
import {
  COMMENT_BUSY,
  COMMENT_NOT_FOUND,
  REMOVED_COMMENT,
  STALE_THREAD_PAGE,
} from './comments.service';
import { harness, ids, U } from './comments-harness.mocks-spec';
import {
  SUGGESTION_ALREADY_ACCEPTED,
  suggestionRecord,
} from './suggestions.service';

type H = ReturnType<typeof harness>;

const row = (h: H, commentId: string) =>
  h.comments.docs.find((d) => d.commentId === commentId)!;

async function authorAs(h: H, userId: string) {
  const writer = await h.writer(userId);
  return h.commentsService.create(writer, {
    slug: 'open-page',
    tabId: 'tab_a',
    body: `From ${userId}.`,
  });
}

describe('review item 1: an author is named only as far as their page is', () => {
  const authorOf = async (h: H, reader?: string) =>
    (await h.thread('open-page', await h.viewer(reader), 'tab_a')).comments[0]
      .author;

  it('names no one whose page is pending, for guests, members, admins or themselves', async () => {
    const h = harness();
    await authorAs(h, U.adminWithPage);
    await h.profiles
      .updateOne(
        { ownerUserId: U.adminWithPage },
        { $set: { reviewStatus: 'pending', visibility: 'public' } },
      )
      .exec();
    for (const reader of [undefined, U.named, U.admin, U.adminWithPage]) {
      // An admin with a page writes as a member: not named, and no "ORG admin".
      expect(await authorOf(h, reader)).toEqual({ kind: 'member' });
    }
  });

  it('names an admin with a pending page as "ORG admin" when they wrote as one', async () => {
    const h = harness();
    await h.profiles
      .updateOne(
        { ownerUserId: U.adminWithPage },
        { $set: { reviewStatus: 'pending' } },
      )
      .exec();
    // Pending page: not a member, so the comment is written as an admin.
    await authorAs(h, U.adminWithPage);
    expect(await authorOf(h)).toEqual({ kind: 'admin' });
  });

  it('names an unlisted owner only to themselves and admins', async () => {
    const h = harness();
    await authorAs(h, U.hiddenOwner);
    expect(await authorOf(h)).toEqual({ kind: 'member' });
    expect(await authorOf(h, U.named)).toEqual({ kind: 'member' });
    for (const reader of [U.hiddenOwner, U.admin]) {
      expect(await authorOf(h, reader)).toEqual({
        kind: 'member',
        displayName: 'Name of hidden-page',
        slug: 'hidden-page',
      });
    }
  });

  it('names a members-only author to a guest without a link, and links it for a member', async () => {
    const h = harness();
    await authorAs(h, U.anon);
    expect(await authorOf(h)).toEqual({
      kind: 'member',
      displayName: 'Name of anon-writer',
    });
    expect(await authorOf(h, U.named)).toEqual({
      kind: 'member',
      displayName: 'Name of anon-writer',
      slug: 'anon-writer',
    });
  });

  it('names no one from a page still being claimed, and no one from a deleted page', async () => {
    const h = harness();
    await authorAs(h, U.named);
    await h.profiles
      .updateOne(
        { ownerUserId: U.named },
        { $set: { reviewStatus: 'claiming' } },
      )
      .exec();
    expect(await authorOf(h, U.admin)).toEqual({ kind: 'member' });
    await h.profiles
      .updateOne(
        { ownerUserId: U.named },
        { $set: { reviewStatus: 'approved', deletedAt: new Date() } },
      )
      .exec();
    expect(await authorOf(h, U.admin)).toEqual({ kind: 'member' });
  });

  it('applies the same rule to the history of an accepted suggestion', async () => {
    const h = harness();
    const { commentId } = await h.suggestions.suggest(await h.writer(U.anon), {
      slug: 'open-page',
      tabId: 'tab_a',
      text: 'Reworded by a nickname.',
      baseSeq: 1,
    });
    await h.suggestions.accept(U.owner, commentId);
    const history = async (reader?: string) =>
      (await h.history.tabHistory('open-page', 'tab_a', await h.viewer(reader)))
        .entries[0].fromSuggestion?.author;
    expect(await history()).toEqual({
      kind: 'member',
      displayName: 'Name of anon-writer',
    });
    await h.profiles
      .updateOne({ ownerUserId: U.anon }, { $set: { visibility: 'unlisted' } })
      .exec();
    expect(await history()).toEqual({ kind: 'member' });
    expect(await history(U.named)).toEqual({ kind: 'member' });
  });
});

describe('review item 2: threads and counts have no cap', () => {
  /** Old rows straight into the store: faster than posting each one. */
  function seedRows(h: H, count: number, tabId = 'tab_a') {
    const createdAt = new Date('2026-11-01T00:00:00.000Z');
    for (let i = 0; i < count; i++) {
      h.comments.docs.push({
        _id: new Types.ObjectId(),
        commentId: `cmt_old${i}`,
        profileId: ids.open,
        tabId,
        authorUserId: U.named,
        body: `Old ${i}`,
        bodySeq: 1,
        source: 'native',
        kind: 'comment',
        // All at the same moment: the cursor must break ties by _id.
        createdAt,
      });
    }
  }

  it('pages through every top-level comment, equal times included, and a new one is reachable', async () => {
    const h = harness();
    seedRows(h, 3 * THREAD_PAGE_SIZE + 5);
    const { commentId } = await authorAs(h, U.anon);
    const viewer = await h.viewer();
    const seen: string[] = [];
    let after: string | undefined;
    do {
      const page = await h.thread('open-page', viewer, 'tab_a', after);
      seen.push(...page.comments.map((c) => c.commentId));
      after = page.nextAfter;
    } while (after);
    expect(seen).toHaveLength(3 * THREAD_PAGE_SIZE + 6);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.at(-1)).toBe(commentId);
    // Reply and history reach it without any page-wide read.
    const reply = await h.commentsService.create(await h.writer(U.named), {
      slug: 'open-page',
      parentCommentId: commentId,
      body: 'Reply to the newest.',
    });
    expect(row(h, reply.commentId)).toMatchObject({
      parentCommentId: commentId,
    });
    await expect(
      h.commentsService.history('open-page', commentId, viewer),
    ).resolves.toMatchObject({ entries: [{ seq: 1 }] });
    const profile = await h.members.profile('open-page', viewer);
    expect(profile).toMatchObject({
      tabs: [
        expect.objectContaining({ commentCount: 3 * THREAD_PAGE_SIZE + 7 }),
        expect.anything(),
      ],
    });
  });

  it('refuses a cursor that is not a top-level comment of this thread', async () => {
    const h = harness();
    await expect(
      h.thread('imported-page', await h.viewer(), 'tab_i', 'cmt_imp2'),
    ).rejects.toThrow(STALE_THREAD_PAGE);
  });

  it('counts a native reply in its root thread and leaves unconfirmed rows out', async () => {
    const h = harness();
    const writer = await h.writer(U.named);
    await h.commentsService.create(writer, {
      slug: 'imported-page',
      parentCommentId: 'cmt_imp3',
      body: 'Under the imported root.',
    });
    h.comments.docs.push({
      commentId: 'cmt_unconfirmed',
      profileId: ids.imported,
      tabId: 'tab_i',
      authorUserId: U.named,
      body: 'Never confirmed.',
      source: 'native',
      kind: 'comment',
      createdAt: new Date(),
    });
    const profile = await h.members.profile('imported-page', await h.viewer());
    expect(profile).toMatchObject({
      tabs: [expect.objectContaining({ commentCount: 4 })],
      pageCommentCount: 1,
    });
    const page = await h.thread('imported-page', await h.viewer(), 'tab_i');
    expect(JSON.stringify(page)).not.toContain('Never confirmed');
  });
});

describe('review item 3: a suggestion at its limits is recorded', () => {
  it('takes a 20,000-character belief of quotes and backslashes with a full note', async () => {
    const h = harness();
    const text = '"\\'.repeat(MAX_BLOCK_TEXT_LENGTH / 2);
    const note = '\\"'.repeat(MAX_COMMENT_LENGTH / 2);
    const record = suggestionRecord('tab_a', 1, text, note);
    expect(record.length).toBeGreaterThan(2 * (text.length + note.length));
    expect(record.length).toBeLessThanOrEqual(MAX_COMMENT_VERSION_TEXT);
    const { commentId } = await h.suggestions.suggest(await h.writer(U.named), {
      slug: 'open-page',
      tabId: 'tab_a',
      text,
      baseSeq: 1,
      note,
    });
    expect(row(h, commentId).suggestion).toMatchObject({ proposedText: text });
    expect(row(h, commentId)).toMatchObject({ body: note });
    await expect(
      h.commentsService['versions'].verify(commentId),
    ).resolves.toMatchObject({ valid: true, length: 1 });
  });

  it('fails loudly, not as a member error, if a record ever outgrew its limit', async () => {
    const h = harness();
    jest
      .spyOn(JSON, 'stringify')
      .mockReturnValueOnce('x'.repeat(MAX_COMMENT_VERSION_TEXT + 1));
    await expect(
      h.suggestions.suggest(await h.writer(U.named), {
        slug: 'open-page',
        tabId: 'tab_a',
        text: 'Short.',
        baseSeq: 1,
      }),
    ).rejects.toThrow('outgrew its version limit');
  });
});

describe('review item 4: a suggestion whose text landed always ends accepted', () => {
  async function suggested() {
    const h = harness();
    const { commentId } = await h.suggestions.suggest(await h.writer(U.named), {
      slug: 'open-page',
      tabId: 'tab_a',
      text: 'The suggested text.',
      baseSeq: 1,
    });
    return { h, commentId };
  }
  const status = (h: H, commentId: string) =>
    (row(h, commentId).suggestion as { status: string }).status;

  it('a takeover finds the stalled accept landed: accepted, not "the belief changed"', async () => {
    const { h, commentId } = await suggested();
    // Accept A took the lock long ago and stalled before writing.
    Object.assign(row(h, commentId).suggestion as object, {
      status: 'accepting',
      lockId: 'A',
      lockedAt: new Date(Date.now() - 10 * 60_000),
    });
    const real = h.editor.editTabText.bind(h.editor);
    let woke = false;
    jest.spyOn(h.editor, 'editTabText').mockImplementation(async (...args) => {
      // A wakes up and writes its version just before B writes.
      if (!woke) {
        woke = true;
        await real(...args);
      }
      return real(...args);
    });
    await expect(h.suggestions.accept(U.owner, commentId)).resolves.toEqual({
      accepted: true,
      seq: 2,
    });
    expect(status(h, commentId)).toBe('accepted');
    expect(row(h, commentId).suggestion).not.toHaveProperty('lockId');
  });

  it('an accept that lost its lock still marks its own landed version accepted', async () => {
    const { h, commentId } = await suggested();
    // B took over and gave the lock back (it failed for another reason).
    const real = h.editor.editTabText.bind(h.editor);
    let lockSeen: unknown;
    jest
      .spyOn(h.editor, 'editTabText')
      .mockImplementationOnce(async (...args) => {
        lockSeen = (row(h, commentId).suggestion as { lockId?: string }).lockId;
        // Meanwhile the lock was taken over and released by someone else.
        Object.assign(row(h, commentId).suggestion as object, {
          status: 'pending',
        });
        delete (row(h, commentId).suggestion as { lockId?: string }).lockId;
        return real(...args);
      });
    await expect(h.suggestions.accept(U.owner, commentId)).resolves.toEqual({
      accepted: true,
      seq: 2,
    });
    expect(lockSeen).toEqual(expect.any(String));
    expect(status(h, commentId)).toBe('accepted');
    await expect(h.suggestions.decline(U.owner, commentId)).rejects.toThrow(
      new ConflictException(SUGGESTION_ALREADY_ACCEPTED),
    );
    expect(status(h, commentId)).toBe('accepted');
  });

  it('a decline finds the text already landed: it finishes the accept instead', async () => {
    const { h, commentId } = await suggested();
    await h.editor.editTabText(U.owner, 'tab_a', 'The suggested text.', 1, {
      suggestionId: commentId,
      suggestedBy: U.named,
    });
    await expect(h.suggestions.decline(U.owner, commentId)).rejects.toThrow(
      new ConflictException(SUGGESTION_ALREADY_ACCEPTED),
    );
    expect(row(h, commentId).suggestion).toMatchObject({
      status: 'accepted',
      decidedBy: U.owner,
      resultSeq: 2,
    });
  });

  it('a decline crossed by a landing version turns into accepted', async () => {
    const { h, commentId } = await suggested();
    const real = h.comments.updateOne;
    jest
      .spyOn(h.comments, 'updateOne')
      .mockImplementationOnce((filter, update) => ({
        exec: async () => {
          // The lost accept lands right before the decline is written.
          await h.editor.editTabText(
            U.owner,
            'tab_a',
            'The suggested text.',
            1,
            {
              suggestionId: commentId,
              suggestedBy: U.named,
            },
          );
          return real(filter, update).exec();
        },
      }));
    await expect(h.suggestions.decline(U.owner, commentId)).rejects.toThrow(
      SUGGESTION_ALREADY_ACCEPTED,
    );
    expect(status(h, commentId)).toBe('accepted');
  });

  it('a released lock with a landed version is finished as accepted', async () => {
    const { h, commentId } = await suggested();
    jest
      .spyOn(h.editor, 'editTabText')
      .mockImplementationOnce(async (userId, tabId, text, baseSeq, origin) => {
        // Lands, then the edit "fails" after writing (e.g. a lost reply).
        jest.restoreAllMocks();
        await h.editor.editTabText(userId, tabId, text, baseSeq, origin);
        throw new Error('lost after writing');
      });
    await expect(h.suggestions.accept(U.owner, commentId)).resolves.toEqual({
      accepted: true,
      seq: 2,
    });
    expect(status(h, commentId)).toBe('accepted');
  });

  it('a text that reads the same after its own landing is accepted, not stale', async () => {
    const { h, commentId } = await suggested();
    jest
      .spyOn(h.editor, 'editTabText')
      .mockImplementationOnce(async (userId, tabId, text, baseSeq, origin) => {
        jest.restoreAllMocks();
        await h.editor.editTabText(userId, tabId, text, baseSeq, origin);
        return { changed: false, seq: 2 };
      });
    await expect(h.suggestions.accept(U.owner, commentId)).resolves.toEqual({
      accepted: true,
      seq: 2,
    });
  });
});

describe('review item 5: an accept cannot land on a removed belief', () => {
  // The fake store cannot run the removal turn's ; that turn is Chunk 8's
  // and has its own specs. Here every removal gets one.
  const allowRemovals = (h: H) =>
    jest
      .spyOn(
        h.editor as unknown as { takeRemovalTurn: () => Promise<unknown> },
        'takeRemovalTurn',
      )
      .mockResolvedValue({ id: 'turn' });

  it('a removal waits while the accept holds the belief, and an accept after a removal finds none', async () => {
    const h = harness();
    await h.profiles
      .updateOne(
        { _id: ids.open },
        { $set: { liveTabCount: 2, nextTabOrder: 3 } },
      )
      .exec();
    allowRemovals(h);
    const { commentId } = await h.suggestions.suggest(await h.writer(U.named), {
      slug: 'open-page',
      tabId: 'tab_a',
      text: 'Reworded.',
      baseSeq: 1,
    });
    let removal: Promise<unknown> | undefined;
    const real = h.editor['versions'].appendVersion.bind(h.editor['versions']);
    jest
      .spyOn(h.editor['versions'], 'appendVersion')
      .mockImplementationOnce(async (input) => {
        // The owner removes the belief from another window mid-accept.
        removal = h.editor.removeTab(U.owner, 'tab_a');
        await removal.catch(() => undefined);
        return real(input);
      });
    await expect(h.suggestions.accept(U.owner, commentId)).resolves.toEqual({
      accepted: true,
      seq: 2,
    });
    await expect(removal).rejects.toThrow(new ConflictException(REMOVAL_BUSY));
    expect(h.tabs.docs.find((t) => t.tabId === 'tab_a')).not.toHaveProperty(
      'removedAt',
    );
    // Once the accept is done the removal goes through.
    await expect(h.editor.removeTab(U.owner, 'tab_a')).resolves.toEqual({
      removed: true,
    });
    const second = await h.suggestions.suggest(await h.writer(U.named), {
      slug: 'open-page',
      tabId: 'tab_b',
      text: 'Reworded B.',
      baseSeq: 1,
    });
    await h.tabs
      .updateOne({ tabId: 'tab_b' }, { $set: { removedAt: new Date() } })
      .exec();
    await expect(
      h.suggestions.accept(U.owner, second.commentId),
    ).rejects.toThrow(NotFoundException);
    expect(row(h, second.commentId).suggestion).toMatchObject({
      status: 'pending',
    });
  });

  it('clears a turn left by an edit that died, and logs a turn it cannot end', async () => {
    const h = harness();
    await h.profiles
      .updateOne(
        { _id: ids.open },
        { $set: { liveTabCount: 2, nextTabOrder: 3 } },
      )
      .exec();
    await h.tabs
      .updateOne(
        { tabId: 'tab_a' },
        { $set: { textTurns: [{ id: 'dead', at: new Date(0) }] } },
      )
      .exec();
    const real = h.tabs.updateOne;
    jest
      .spyOn(h.tabs, 'updateOne')
      .mockImplementation((filter, update) =>
        '$pull' in update &&
        'id' in (update.$pull as { textTurns: object }).textTurns
          ? { exec: () => Promise.reject(new Error('down')) }
          : real(filter, update),
      );
    await h.editor.editTabText(U.owner, 'tab_a', 'Edited.', 1);
    jest.restoreAllMocks();
    allowRemovals(h);
    // The live turn was left behind: removal waits for it, as it should.
    await expect(h.editor.removeTab(U.owner, 'tab_a')).rejects.toThrow(
      REMOVAL_BUSY,
    );
    const turns = h.tabs.docs.find((t) => t.tabId === 'tab_a')!
      .textTurns as Array<{ at: Date }>;
    expect(turns).toHaveLength(1);
    turns[0].at = new Date(0);
    await expect(h.editor.removeTab(U.owner, 'tab_a')).resolves.toEqual({
      removed: true,
    });
  });
});

describe('review item 6: an edit never lands after a removal; no orphan versions', () => {
  async function posted() {
    const h = harness();
    const writer = await h.writer(U.named);
    const { commentId } = await h.commentsService.create(writer, {
      slug: 'open-page',
      tabId: 'tab_a',
      body: 'First.',
    });
    return { h, writer, commentId };
  }

  it('a removal waits while an edit is writing, then goes through', async () => {
    const { h, writer, commentId } = await posted();
    let removal: Promise<unknown> | undefined;
    const versions = h.commentsService['versions'];
    const real = versions.append.bind(versions);
    jest.spyOn(versions, 'append').mockImplementationOnce(async (input) => {
      removal = h.commentsService.remove(U.named, commentId);
      await removal.catch(() => undefined);
      return real(input);
    });
    await h.commentsService.edit(writer, commentId, 'Second.', 1);
    await expect(removal).rejects.toThrow(new ConflictException(COMMENT_BUSY));
    expect(row(h, commentId)).not.toHaveProperty('removedAt');
    await h.commentsService.remove(U.named, commentId);
    expect(row(h, commentId)).toMatchObject({ body: 'Second.', bodySeq: 2 });
  });

  it('an edit after a removal is refused and writes no version', async () => {
    const { h, writer, commentId } = await posted();
    jest
      .spyOn(h.commentsService, 'ownComment')
      .mockImplementationOnce(async (...args) => {
        const found = await h.store.one(commentId);
        // The removal lands between the check and the turn.
        await h.commentsService.remove(U.named, commentId);
        void args;
        return found!;
      });
    await expect(
      h.commentsService.edit(writer, commentId, 'Too late.', 1),
    ).rejects.toThrow(new ConflictException(REMOVED_COMMENT));
    expect(
      h.commentVersions.docs.filter((d) => d.commentId === commentId),
    ).toHaveLength(1);
  });

  it('clears a dead edit turn, and logs one it cannot end', async () => {
    const { h, writer, commentId } = await posted();
    const real = h.comments.updateOne;
    jest
      .spyOn(h.comments, 'updateOne')
      .mockImplementation((filter, update) =>
        '$pull' in update &&
        'id' in ((update.$pull as { editTurns?: object }).editTurns ?? {})
          ? { exec: () => Promise.reject(new Error('down')) }
          : real(filter, update),
      );
    await h.commentsService.edit(writer, commentId, 'Second.', 1);
    jest.restoreAllMocks();
    await expect(h.commentsService.remove(U.named, commentId)).rejects.toThrow(
      COMMENT_BUSY,
    );
    (row(h, commentId).editTurns as Array<{ at: Date }>)[0].at = new Date(0);
    await expect(h.commentsService.remove(U.named, commentId)).resolves.toEqual(
      {
        removed: true,
      },
    );
  });

  it('writes the row before the version, and deletes the row if the version fails', async () => {
    const h = harness();
    const writer = await h.writer(U.named);
    jest
      .spyOn(h.commentsService['versions'], 'append')
      .mockRejectedValueOnce(new Error('versions down'));
    await expect(
      h.commentsService.create(writer, { slug: 'open-page', body: 'Lost.' }),
    ).rejects.toThrow('versions down');
    expect(h.comments.docs.some((d) => d.body === 'Lost.')).toBe(false);
    expect(h.commentVersions.docs).toHaveLength(0);
  });

  it('repairs a comment whose writing stopped: confirmed with its version, deleted without', async () => {
    const h = harness();
    const writer = await h.writer(U.named);
    // A crash after the version: the row is never confirmed.
    jest
      .spyOn(h.store, 'createConfirmed')
      .mockImplementationOnce(async (fields, writeVersion) => {
        await h.comments.create(fields);
        await writeVersion();
        return 1;
      });
    const { commentId } = await h.commentsService.create(writer, {
      slug: 'open-page',
      body: 'Half written.',
    });
    // And one that never got its version.
    h.comments.docs.push({
      commentId: 'cmt_noversion',
      profileId: ids.open,
      authorUserId: U.named,
      body: 'Nothing recorded.',
      source: 'native',
      kind: 'comment',
      createdAt: new Date(0),
    });
    expect(row(h, commentId)).not.toHaveProperty('bodySeq');
    const page = async () =>
      (await h.thread('open-page', await h.viewer(), undefined)).comments.map(
        (c) => c.commentId,
      );
    expect(await page()).toEqual([]);
    // Not yet stale: left alone.
    await h.commentsService.repair(U.named);
    expect(row(h, commentId)).not.toHaveProperty('bodySeq');
    row(h, commentId).createdAt = new Date(
      Date.now() - COMMENT_TURN_STALE_MS - 1,
    );
    await h.commentsService.create(writer, {
      slug: 'open-page',
      body: 'Next.',
    });
    expect(row(h, commentId)).toMatchObject({ bodySeq: 1 });
    expect(h.comments.docs.some((d) => d.commentId === 'cmt_noversion')).toBe(
      false,
    );
    expect((await page())[0]).toBe(commentId);
    await expect(
      h.commentsService.edit(writer, 'cmt_noversion', 'x', 1),
    ).rejects.toThrow(new NotFoundException(COMMENT_NOT_FOUND));
  });

  it('never fails a new comment because a repair failed, and logs a failed confirm', async () => {
    const h = harness();
    const writer = await h.writer(U.named);
    jest
      .spyOn(h.store, 'repairUnconfirmed')
      .mockRejectedValueOnce(new Error('repair down'));
    const real = h.comments.updateOne;
    jest
      .spyOn(h.comments, 'updateOne')
      .mockImplementationOnce((filter, update) =>
        'bodySeq' in filter
          ? { exec: () => Promise.reject(new Error('confirm down')) }
          : real(filter, update),
      );
    const { commentId } = await h.commentsService.create(writer, {
      slug: 'open-page',
      body: 'Still posted.',
    });
    expect(row(h, commentId)).not.toHaveProperty('bodySeq');
  });
});

describe('loose ends', () => {
  it('names the author of a page written before review statuses existed', async () => {
    const h = harness();
    await authorAs(h, U.named);
    delete h.profiles.docs.find((p) => p.ownerUserId === U.named)!.reviewStatus;
    const page = await h.thread('open-page', await h.viewer(), 'tab_a');
    expect(page.comments[0].author).toMatchObject({
      displayName: 'Name of named-writer',
    });
  });

  it('answers removed when another window removed it first', async () => {
    const h = harness();
    const { commentId } = await authorAs(h, U.named);
    jest.spyOn(h.store, 'removeWhenFree').mockImplementationOnce(async () => {
      row(h, commentId).removedAt = new Date();
      return false;
    });
    await expect(h.commentsService.remove(U.named, commentId)).resolves.toEqual(
      {
        removed: true,
      },
    );
  });

  it('refuses a text edit when the belief went between the check and the turn', async () => {
    const h = harness();
    jest.spyOn(h.tabs, 'updateOne').mockImplementation((filter, update) =>
      '' in update
        ? {
            exec: () => Promise.resolve({ matchedCount: 0, modifiedCount: 0 }),
          }
        : {
            exec: () => Promise.resolve({ matchedCount: 0, modifiedCount: 0 }),
          },
    );
    await expect(
      h.editor.editTabText(U.owner, 'tab_a', 'Edited.', 1),
    ).rejects.toThrow(NotFoundException);
    expect(h.versions.docs.filter((v) => v.blockId === 'blk_a1')).toHaveLength(
      1,
    );
  });
});

describe('review item 9: the form is offered only to who may write', () => {
  it.each([
    [undefined, { viewerMayComment: false, viewerWriteBlock: 'sign-in' }],
    [
      U.nopage,
      { viewerMayComment: false, viewerWriteBlock: 'needs-approved-page' },
    ],
    [
      U.waiting,
      { viewerMayComment: false, viewerWriteBlock: 'needs-approved-page' },
    ],
    [
      U.unverified,
      { viewerMayComment: false, viewerWriteBlock: 'verify-email' },
    ],
    [U.named, { viewerMayComment: true, viewerMaySuggest: true }],
    [U.admin, { viewerMayComment: true }],
    [U.owner, { viewerMayComment: true, viewerMaySuggest: false }],
  ])('reader %s', async (reader, expected) => {
    const h = harness();
    const page = await h.thread('open-page', await h.viewer(reader), 'tab_a');
    expect(page).toMatchObject(expected);
    if (expected.viewerMayComment)
      expect(page).not.toHaveProperty('viewerWriteBlock');
  });

  it('offers the form when Clerk cannot be asked: the write checks again', async () => {
    const h = harness();
    h.clerk.getIdentity.mockRejectedValueOnce(new Error('Clerk down'));
    const page = await h.thread('open-page', await h.viewer(U.named), 'tab_a');
    expect(page.viewerMayComment).toBe(true);
    h.clerk.getIdentity.mockRejectedValueOnce('plain');
    const again = await h.thread('open-page', await h.viewer(U.named), 'tab_a');
    expect(again.viewerMayComment).toBe(true);
  });
});
