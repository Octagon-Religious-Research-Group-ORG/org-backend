/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.any() matchers */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { BlockVersionsService } from '../../social/block-versions.service';
import { MAX_BLOCK_TEXT_LENGTH } from '../../social/schemas/block-version.schema';
import { MAX_COMMENT_LENGTH } from '../../social/schemas/comment.schema';
import { DECIDED_SUGGESTION } from './comments.service';
import { harness, U } from './comments-harness.mocks-spec';
import type { FakeModel } from '../../test-support/fake-model.mocks-spec';
import {
  ACCEPT_LOCK_STALE_MS,
  BELIEF_CHANGED_RELOAD,
  SUGGEST_ON_OWN_PAGE,
  SUGGESTION_ALREADY_DECIDED,
  SUGGESTION_BUSY,
  SUGGESTION_SAME_TEXT,
  SUGGESTION_STALE,
  SUGGESTION_TOO_LONG,
} from './suggestions.service';

async function suggested(text = 'Synthetic belief A, reworded.') {
  const h = harness();
  const writer = await h.writer(U.named);
  const { commentId } = await h.suggestions.suggest(writer, {
    slug: 'open-page',
    tabId: 'tab_a',
    text,
    baseSeq: 1,
    note: 'Clearer, I think.',
  });
  return { h, writer, commentId };
}

const row = (h: ReturnType<typeof harness>, commentId: string) =>
  h.comments.docs.find((d) => d.commentId === commentId)!;

describe('SuggestionsService', () => {
  describe('suggesting', () => {
    it('records the proposed text against the version it was written on', async () => {
      const { h, commentId } = await suggested(' Reworded\u0007 text. ');
      expect(row(h, commentId)).toMatchObject({
        kind: 'suggestion',
        tabId: 'tab_a',
        body: 'Clearer, I think.',
        authorUserId: U.named,
        suggestion: {
          proposedText: 'Reworded text.',
          baseSeq: 1,
          status: 'pending',
        },
      });
      await expect(
        h.commentsService['versions'].verify(commentId),
      ).resolves.toMatchObject({ valid: true, length: 1 });

      const forOwner = await h.commentsService.thread(
        'open-page',
        await h.viewer(U.owner),
        'tab_a',
      );
      expect(forOwner.comments[0]).toMatchObject({
        kind: 'suggestion',
        body: 'Clearer, I think.',
        mine: false,
        edited: false,
        suggestion: {
          proposedText: 'Reworded text.',
          baseSeq: 1,
          status: 'pending',
          stale: false,
          canDecide: true,
        },
      });
      expect(forOwner).toMatchObject({
        viewerMayComment: true,
        viewerMaySuggest: false,
      });
      const forAuthor = await h.commentsService.thread(
        'open-page',
        await h.viewer(U.named),
        'tab_a',
      );
      expect(forAuthor.comments[0]).toMatchObject({
        mine: true,
        suggestion: { canDecide: false },
      });
      expect(forAuthor.comments[0]).not.toHaveProperty('seq');
    });

    it('takes a suggestion without a note', async () => {
      const h = harness();
      const { commentId } = await h.suggestions.suggest(
        await h.writer(U.anon),
        { slug: 'open-page', tabId: 'tab_b', text: 'New B.', baseSeq: 1 },
      );
      expect(row(h, commentId)).toMatchObject({ body: '' });
    });

    it.each([
      ['the owner', U.owner, {}, SUGGEST_ON_OWN_PAGE],
      ['an empty text', U.named, { text: '​' }, 'A suggestion needs'],
      [
        'a text over one version',
        U.named,
        { text: 'a'.repeat(MAX_BLOCK_TEXT_LENGTH + 1) },
        SUGGESTION_TOO_LONG,
      ],
      [
        'a note over a comment',
        U.named,
        { note: 'a'.repeat(MAX_COMMENT_LENGTH + 1) },
        'A note can hold',
      ],
      [
        'the same text',
        U.named,
        { text: 'Synthetic belief A.' },
        SUGGESTION_SAME_TEXT,
      ],
    ])('refuses %s', async (_name, userId, change, message) => {
      const h = harness();
      await expect(
        h.suggestions.suggest(await h.writer(userId), {
          slug: 'open-page',
          tabId: 'tab_a',
          text: 'Another wording.',
          baseSeq: 1,
          ...change,
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        h.suggestions.suggest(await h.writer(userId), {
          slug: 'open-page',
          tabId: 'tab_a',
          text: 'Another wording.',
          baseSeq: 1,
          ...change,
        }),
      ).rejects.toThrow(message);
    });

    it('refuses a suggestion on a version that is no longer the newest', async () => {
      const h = harness();
      await expect(
        h.suggestions.suggest(await h.writer(U.named), {
          slug: 'open-page',
          tabId: 'tab_a',
          text: 'Late wording.',
          baseSeq: 0,
        }),
      ).rejects.toThrow(new ConflictException(BELIEF_CHANGED_RELOAD));
    });

    it('refuses a removed belief and a page the writer cannot read', async () => {
      const h = harness();
      const writer = await h.writer(U.named);
      await expect(
        h.suggestions.suggest(writer, {
          slug: 'open-page',
          tabId: 'tab_removed',
          text: 'x',
          baseSeq: 1,
        }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        h.suggestions.suggest(writer, {
          slug: 'hidden-page',
          tabId: 'tab_h',
          text: 'x',
          baseSeq: 1,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('lets an admin with no page suggest', async () => {
      const h = harness();
      const { commentId } = await h.suggestions.suggest(
        await h.writer(U.admin),
        { slug: 'open-page', tabId: 'tab_a', text: 'Admin idea.', baseSeq: 1 },
      );
      expect(row(h, commentId)).toMatchObject({ writtenAsAdmin: true });
    });
  });

  describe('accepting', () => {
    it('writes the text as the next version, which records the suggestion and its author, in its hash', async () => {
      const { h, commentId } = await suggested();
      await expect(h.suggestions.accept(U.owner, commentId)).resolves.toEqual({
        accepted: true,
        seq: 2,
      });
      const version = h.versions.docs.find(
        (d) => d.blockId === 'blk_a1' && d.seq === 2,
      );
      expect(version).toMatchObject({
        text: 'Synthetic belief A, reworded.',
        authorUserId: U.owner,
        suggestionId: commentId,
        suggestedBy: U.named,
      });
      const chain = new BlockVersionsService(
        h.versions as never,
        h.blocks as never,
      );
      await expect(chain.verifyBlock('blk_a1')).resolves.toMatchObject({
        valid: true,
        length: 2,
      });
      // Changing who suggested it breaks the chain.
      version!.suggestedBy = U.anon;
      await expect(chain.verifyBlock('blk_a1')).resolves.toMatchObject({
        valid: false,
        reason: 'hash-mismatch',
      });
      version!.suggestedBy = U.named;

      expect(row(h, commentId).suggestion).toMatchObject({
        status: 'accepted',
        decidedBy: U.owner,
        decidedAt: expect.any(Date),
        resultSeq: 2,
      });
      expect(row(h, commentId).suggestion).not.toHaveProperty('lockId');

      const history = await h.history.tabHistory(
        'open-page',
        'tab_a',
        await h.viewer(),
      );
      expect(history.entries[0]).toMatchObject({
        seq: 2,
        text: 'Synthetic belief A, reworded.',
        fromSuggestion: {
          commentId,
          author: {
            kind: 'member',
            displayName: 'Name of named-writer',
            slug: 'named-writer',
          },
        },
      });
      expect(history.entries[1]).not.toHaveProperty('fromSuggestion');

      const page = await h.members.profile('open-page', await h.viewer());
      expect(page).toMatchObject({
        tabs: [
          expect.objectContaining({
            tabId: 'tab_a',
            textSeq: 2,
            commentCount: 1,
            paragraphs: [
              expect.objectContaining({
                text: 'Synthetic belief A, reworded.',
              }),
            ],
          }),
          expect.anything(),
        ],
      });
      const thread = await h.commentsService.thread(
        'open-page',
        await h.viewer(U.owner),
        'tab_a',
      );
      expect(thread.comments[0].suggestion).toEqual({
        proposedText: 'Synthetic belief A, reworded.',
        baseSeq: 1,
        status: 'accepted',
        decidedAt: expect.any(String),
      });
    });

    it('refuses a stale suggestion, leaves it pending and shows it as stale', async () => {
      const { h, commentId } = await suggested();
      await h.editor.editTabText(U.owner, 'tab_a', 'Owner changed it.', 1);
      await expect(h.suggestions.accept(U.owner, commentId)).rejects.toThrow(
        new ConflictException(SUGGESTION_STALE),
      );
      expect(row(h, commentId).suggestion).toMatchObject({ status: 'pending' });
      expect(row(h, commentId).suggestion).not.toHaveProperty('lockId');
      const thread = await h.commentsService.thread(
        'open-page',
        await h.viewer(U.owner),
        'tab_a',
      );
      expect(thread.comments[0].suggestion).toMatchObject({
        stale: true,
        canDecide: true,
      });
      // It can still be declined.
      await expect(h.suggestions.decline(U.owner, commentId)).resolves.toEqual({
        declined: true,
      });
    });

    it('of two suggestions on one version, accepts one and refuses the other', async () => {
      const { h, commentId: first } = await suggested('Wording one.');
      const { commentId: second } = await h.suggestions.suggest(
        await h.writer(U.anon),
        { slug: 'open-page', tabId: 'tab_a', text: 'Wording two.', baseSeq: 1 },
      );
      await h.suggestions.accept(U.owner, first);
      await expect(h.suggestions.accept(U.owner, second)).rejects.toThrow(
        SUGGESTION_STALE,
      );
    });

    it('refuses text that already reads this way on a newer version', async () => {
      const { h, commentId } = await suggested('Owner wrote this too.');
      await h.editor.editTabText(U.owner, 'tab_a', 'Owner wrote this too.', 1);
      await expect(h.suggestions.accept(U.owner, commentId)).rejects.toThrow(
        SUGGESTION_STALE,
      );
      expect(row(h, commentId).suggestion).toMatchObject({ status: 'pending' });
    });

    it('passes on any other failure of the edit, releasing the lock', async () => {
      const { h, commentId } = await suggested();
      jest
        .spyOn(h.editor, 'editTabText')
        .mockRejectedValueOnce(new ConflictException('Something else'));
      await expect(h.suggestions.accept(U.owner, commentId)).rejects.toThrow(
        'Something else',
      );
      jest
        .spyOn(h.editor, 'editTabText')
        .mockRejectedValueOnce(new Error('down'));
      await expect(h.suggestions.accept(U.owner, commentId)).rejects.toThrow(
        'down',
      );
      expect(row(h, commentId).suggestion).toMatchObject({ status: 'pending' });
    });

    it('refuses anyone but the owner, a removed suggestion, a plain comment, and an unowned page', async () => {
      const { h, commentId } = await suggested();
      for (const userId of [U.named, U.admin, U.anon]) {
        await expect(h.suggestions.accept(userId, commentId)).rejects.toThrow(
          NotFoundException,
        );
        await expect(h.suggestions.decline(userId, commentId)).rejects.toThrow(
          NotFoundException,
        );
      }
      const plain = await h.commentsService.create(await h.writer(U.named), {
        slug: 'open-page',
        tabId: 'tab_a',
        body: 'Just a comment.',
      });
      await expect(
        h.suggestions.accept(U.owner, plain.commentId),
      ).rejects.toThrow(NotFoundException);
      await h.commentsService.remove(U.named, commentId);
      await expect(h.suggestions.accept(U.owner, commentId)).rejects.toThrow(
        NotFoundException,
      );

      // Imported pages have no owner until claimed (Chunk 11).
      const onImported = await h.suggestions.suggest(await h.writer(U.named), {
        slug: 'imported-page',
        tabId: 'tab_i',
        text: 'Merged wording.',
        baseSeq: 1,
      });
      await expect(
        h.suggestions.accept(U.owner, onImported.commentId),
      ).rejects.toThrow(NotFoundException);
    });

    it('treats a suggestion row without a belief as not found', async () => {
      const { h, commentId } = await suggested();
      delete row(h, commentId).tabId;
      await expect(h.suggestions.accept(U.owner, commentId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('finishes an accept that died after writing its version', async () => {
      const { h, commentId } = await suggested();
      jest
        .spyOn(h.comments, 'updateOne')
        .mockReturnValueOnce({
          exec: () => Promise.resolve({ matchedCount: 1, modifiedCount: 1 }),
        })
        .mockReturnValueOnce({ exec: () => Promise.reject(new Error('down')) });
      // The lock "succeeds" without writing; the marking then fails.
      await expect(h.suggestions.accept(U.owner, commentId)).resolves.toEqual({
        accepted: true,
        seq: 2,
      });
      expect(row(h, commentId).suggestion).toMatchObject({ status: 'pending' });
      await expect(h.suggestions.accept(U.owner, commentId)).resolves.toEqual({
        accepted: true,
        seq: 2,
      });
      expect(row(h, commentId).suggestion).toMatchObject({
        status: 'accepted',
        resultSeq: 2,
      });
      await expect(h.suggestions.accept(U.owner, commentId)).rejects.toThrow(
        new ConflictException(SUGGESTION_ALREADY_DECIDED),
      );
    });

    it('waits for an accept holding the lock, and takes over a dead one', async () => {
      const { h, commentId } = await suggested();
      Object.assign(row(h, commentId).suggestion as object, {
        status: 'accepting',
        lockId: 'other',
        lockedAt: new Date(),
      });
      await expect(h.suggestions.accept(U.owner, commentId)).rejects.toThrow(
        new ConflictException(SUGGESTION_BUSY),
      );
      await expect(h.suggestions.decline(U.owner, commentId)).rejects.toThrow(
        new ConflictException(SUGGESTION_BUSY),
      );
      await expect(
        h.commentsService.remove(U.named, commentId),
      ).rejects.toThrow(new ConflictException(DECIDED_SUGGESTION));
      // Read as pending meanwhile.
      const thread = await h.commentsService.thread(
        'open-page',
        await h.viewer(U.owner),
        'tab_a',
      );
      expect(thread.comments[0].suggestion?.status).toBe('pending');

      (row(h, commentId).suggestion as { lockedAt: Date }).lockedAt = new Date(
        Date.now() - ACCEPT_LOCK_STALE_MS - 1000,
      );
      await expect(h.suggestions.accept(U.owner, commentId)).resolves.toEqual({
        accepted: true,
        seq: 2,
      });
    });

    it('logs, and leaves the lock to expire, when releasing it fails', async () => {
      const { h, commentId } = await suggested();
      await h.editor.editTabText(U.owner, 'tab_a', 'Owner changed it.', 1);
      const realUpdate: FakeModel['updateOne'] = (filter, change) =>
        h.comments.updateOne(filter, change);
      jest
        .spyOn(h.comments, 'updateOne')
        .mockImplementationOnce(realUpdate)
        .mockReturnValueOnce({ exec: () => Promise.reject(new Error('down')) });
      await expect(h.suggestions.accept(U.owner, commentId)).rejects.toThrow(
        SUGGESTION_STALE,
      );
      expect(row(h, commentId).suggestion).toMatchObject({
        status: 'accepting',
      });
    });

    it('handles a suggestion whose author left no id', async () => {
      const { h, commentId } = await suggested();
      delete row(h, commentId).authorUserId;
      await h.suggestions.accept(U.owner, commentId);
      expect(
        h.versions.docs.find((d) => d.suggestionId === commentId),
      ).toMatchObject({ suggestedBy: '' });
    });
  });

  it('accepts a suggestion on a belief that had no text yet', async () => {
    const h = harness();
    h.blocks.docs.splice(
      h.blocks.docs.findIndex((d) => d.blockId === 'blk_b1'),
      1,
    );
    const { commentId } = await h.suggestions.suggest(await h.writer(U.named), {
      slug: 'open-page',
      tabId: 'tab_b',
      text: 'Words for an empty belief.',
      baseSeq: 0,
    });
    await expect(h.suggestions.accept(U.owner, commentId)).resolves.toEqual({
      accepted: true,
      seq: 1,
    });
    expect(
      h.versions.docs.find((d) => d.blockId === 'txt_tab_b'),
    ).toMatchObject({ seq: 1, suggestionId: commentId });
  });

  describe('declining', () => {
    it('records who and when, keeps it in the thread, and cannot be undone here', async () => {
      const { h, commentId } = await suggested();
      await expect(h.suggestions.decline(U.owner, commentId)).resolves.toEqual({
        declined: true,
      });
      expect(row(h, commentId).suggestion).toMatchObject({
        status: 'declined',
        decidedBy: U.owner,
        decidedAt: expect.any(Date),
      });
      await expect(h.suggestions.decline(U.owner, commentId)).rejects.toThrow(
        new ConflictException(SUGGESTION_ALREADY_DECIDED),
      );
      await expect(h.suggestions.accept(U.owner, commentId)).rejects.toThrow(
        new ConflictException(SUGGESTION_ALREADY_DECIDED),
      );
      await expect(
        h.commentsService.remove(U.named, commentId),
      ).rejects.toThrow(new ConflictException(DECIDED_SUGGESTION));
      const thread = await h.commentsService.thread(
        'open-page',
        await h.viewer(),
        'tab_a',
      );
      expect(thread.comments[0].suggestion).toEqual({
        proposedText: 'Synthetic belief A, reworded.',
        baseSeq: 1,
        status: 'declined',
        decidedAt: expect.any(String),
      });
    });

    it('lets the author withdraw a pending suggestion, which then hides its text', async () => {
      const { h, commentId } = await suggested();
      await expect(
        h.commentsService.remove(U.named, commentId),
      ).resolves.toEqual({ removed: true });
      const thread = await h.commentsService.thread(
        'open-page',
        await h.viewer(U.owner),
        'tab_a',
      );
      expect(thread.comments[0]).toMatchObject({
        removed: true,
        suggestion: { baseSeq: 1, status: 'pending' },
      });
      expect(thread.comments[0].suggestion).not.toHaveProperty('proposedText');
      expect(thread.comments[0].suggestion).not.toHaveProperty('canDecide');
      await expect(
        h.commentsService.edit(await h.writer(U.named), commentId, 'x', 1),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
