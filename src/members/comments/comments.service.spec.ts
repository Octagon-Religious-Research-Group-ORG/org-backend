/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.any() matchers */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { STALE_COMMENT_EDIT } from '../../social/comment-versions.service';
import { MAX_COMMENT_LENGTH } from '../../social/schemas/comment.schema';
import { PROFILE_NOT_FOUND } from '../members.service';
import { describeFailure, THREAD_PAGE_SIZE } from './comment-limits';
import { NEEDS_APPROVED_PAGE, NEEDS_VERIFIED_EMAIL } from './comment-writers';
import {
  COMMENT_NOT_FOUND,
  COMMENT_TOO_LONG,
  EMPTY_COMMENT,
  NO_SUCH_BELIEF,
  REMOVED_COMMENT,
  REPLY_TO_REMOVED,
} from './comments.service';
import { harness, U } from './comments-harness.mocks-spec';

describe('CommentsService', () => {
  describe('who may write (CommentWritersService)', () => {
    it.each([
      ['a guest', undefined, NEEDS_APPROVED_PAGE],
      ['an account with no page', U.nopage, NEEDS_APPROVED_PAGE],
      ['an account whose page is pending', U.waiting, NEEDS_APPROVED_PAGE],
      ['a member without a verified email', U.unverified, NEEDS_VERIFIED_EMAIL],
    ])('refuses %s', async (_name, userId, message) => {
      const h = harness();
      const refusal = userId
        ? h.writer(userId)
        : h.writers.requireWriter({ headers: {} } as never);
      await expect(refusal).rejects.toThrow(new ForbiddenException(message));
    });

    it('lets named and anonymous members and admins write', async () => {
      const h = harness();
      await expect(h.writer(U.named)).resolves.toMatchObject({
        userId: U.named,
        writesAsAdmin: false,
      });
      await expect(h.writer(U.anon)).resolves.toMatchObject({
        kind: 'anonymous-member',
      });
      await expect(h.writer(U.admin)).resolves.toMatchObject({
        writesAsAdmin: true,
      });
      await expect(h.writer(U.adminWithPage)).resolves.toMatchObject({
        writesAsAdmin: false,
      });
      // An admin needs no Clerk email check; a member does.
      expect(h.clerk.getIdentity).toHaveBeenCalledTimes(2);
    });

    it('refuses an account with no email at all', async () => {
      const h = harness();
      h.clerk.getIdentity.mockResolvedValueOnce({ emailVerified: false });
      await expect(h.writer(U.named)).rejects.toThrow(NEEDS_VERIFIED_EMAIL);
    });
  });

  describe('reading', () => {
    it('lists an imported thread with names, dates, quotes and replies under their root', async () => {
      const h = harness();
      // Chunk 8 merged the paragraph the first comment highlights.
      await h.blocks
        .updateOne(
          { blockId: 'blk_i2' },
          { $set: { removedAt: new Date(), mergedInto: 'blk_i1' } },
        )
        .exec();
      const page = await h.thread('imported-page', await h.viewer(), 'tab_i');
      expect(page).toEqual({
        comments: [
          {
            commentId: 'cmt_imp1',
            kind: 'comment',
            source: 'imported',
            author: { kind: 'imported', name: 'Synthetic Pages Author' },
            postedAt: '2026-10-01T12:00:00.000Z',
            importedDate: '2020-05-06T00:00:00.000Z',
            removed: false,
            body: 'An imported synthetic comment.',
            anchorText: 'Second part',
            edited: false,
            mine: false,
            replies: [
              expect.objectContaining({
                commentId: 'cmt_imp2',
                author: { kind: 'imported', name: 'Another Pages Author' },
              }),
              expect.objectContaining({ commentId: 'cmt_imp3' }),
            ],
          },
        ],
        viewerMayComment: false,
        viewerWriteBlock: 'sign-in',
        viewerMaySuggest: false,
      });
      expect(page.comments[0].replies?.[0]).not.toHaveProperty('importedDate');
    });

    it('names the member an imported comment was linked to, by the page-naming rule (Chunk 11)', async () => {
      const h = harness();
      const link = (commentId: string, userId: string) =>
        h.comments
          .updateOne({ commentId }, { $set: { linkedUserId: userId } })
          .exec();
      await link('cmt_imp1', U.named);
      await link('cmt_imp2', U.waiting);
      await link('cmt_imp3', U.anon);
      const page = await h.thread('imported-page', await h.viewer(), 'tab_i');
      const [root] = page.comments;
      // The Pages name stays; the linked member is added, never substituted.
      expect(root.author).toEqual({
        kind: 'imported',
        name: 'Synthetic Pages Author',
        member: { displayName: 'Name of named-writer', slug: 'named-writer' },
      });
      // A pending page names no one.
      expect(root.replies?.[0].author).toEqual({
        kind: 'imported',
        name: 'Another Pages Author',
      });
      // A members-only page: its name to a guest, not its address.
      expect(root.replies?.[1].author).toEqual({
        kind: 'imported',
        name: 'Synthetic Pages Author',
        member: { displayName: 'Name of anon-writer' },
      });
      expect(root.body).toBe('An imported synthetic comment.');
    });

    it('lists comments with no tab in the page thread', async () => {
      const h = harness();
      const page = await h.thread(
        'IMPORTED-page',
        await h.viewer(U.named),
        undefined,
      );
      expect(page.comments.map((c) => c.commentId)).toEqual(['cmt_imp4']);
      expect(page).toMatchObject({
        viewerMayComment: true,
        viewerMaySuggest: true,
      });
    });

    it('lists no thread of a removed belief, for anyone, and keeps its comments', async () => {
      const h = harness();
      for (const userId of [undefined, U.owner, U.admin]) {
        await expect(
          h.thread('open-page', await h.viewer(userId), 'tab_removed'),
        ).rejects.toThrow(new NotFoundException(NO_SUCH_BELIEF));
      }
      expect(
        h.comments.docs.some((d) => d.commentId === 'cmt_old_removed_tab'),
      ).toBe(true);
    });

    it.each([
      ['a guest on a members-only page', 'members-page', 'tab_m', undefined],
      ['a member on an unlisted page', 'hidden-page', 'tab_h', U.named],
      ['a member on a pending page', 'waiting-page', 'tab_w', U.named],
      ['anyone on a deleted page', 'gone-page', undefined, U.named],
    ])('answers 404 to %s', async (_name, slug, tab, userId) => {
      const h = harness();
      await expect(h.thread(slug, await h.viewer(userId), tab)).rejects.toThrow(
        new NotFoundException(PROFILE_NOT_FOUND),
      );
    });

    it.each([
      [
        'an anonymous member on a members-only page',
        'members-page',
        'tab_m',
        U.anon,
      ],
      ['the owner of an unlisted page', 'hidden-page', 'tab_h', U.hiddenOwner],
      ['an admin on an unlisted page', 'hidden-page', 'tab_h', U.admin],
      ['the owner of a pending page', 'waiting-page', 'tab_w', U.waiting],
    ])('lets %s read', async (_name, slug, tab, userId) => {
      const h = harness();
      await expect(
        h.thread(slug, await h.viewer(userId), tab),
      ).resolves.toMatchObject({ comments: [] });
    });

    it('pages top-level comments oldest first, replies with their root', async () => {
      const h = harness();
      const writer = await h.writer(U.named);
      const made: string[] = [];
      for (let i = 0; i < THREAD_PAGE_SIZE + 3; i++) {
        made.push(
          (
            await h.commentsService.create(writer, {
              slug: 'open-page',
              tabId: 'tab_a',
              body: `Synthetic comment ${i}`,
            })
          ).commentId,
        );
      }
      await h.commentsService.create(writer, {
        slug: 'open-page',
        parentCommentId: made[0],
        body: 'Synthetic reply',
      });
      const viewer = await h.viewer();
      const first = await h.thread('open-page', viewer, 'tab_a');
      expect(first.comments).toHaveLength(THREAD_PAGE_SIZE);
      expect(first.comments[0].replies).toHaveLength(1);
      expect(first.nextAfter).toBe(made[THREAD_PAGE_SIZE - 1]);
      const second = await h.thread(
        'open-page',
        viewer,
        'tab_a',
        first.nextAfter,
      );
      expect(second.comments.map((c) => c.commentId)).toEqual(
        made.slice(THREAD_PAGE_SIZE),
      );
      expect(second).not.toHaveProperty('nextAfter');
      await expect(
        h.thread('open-page', viewer, 'tab_a', 'cmt_nope'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('writing', () => {
    it('posts a comment, names its author by their page, links it only for readers allowed there', async () => {
      const h = harness();
      const { commentId, seq } = await h.commentsService.create(
        await h.writer(U.anon),
        { slug: 'open-page', tabId: 'tab_a', body: '  Hello\u0007 there.  ' },
      );
      expect(seq).toBe(1);
      const stored = h.comments.docs.find((d) => d.commentId === commentId);
      expect(stored).toMatchObject({
        body: 'Hello there.',
        authorUserId: U.anon,
        source: 'native',
        kind: 'comment',
        bodySeq: 1,
      });
      expect(stored).not.toHaveProperty('writtenAsAdmin');
      await expect(
        h.commentsService['versions'].verify(commentId),
      ).resolves.toMatchObject({ valid: true, length: 1 });

      // The anonymous writer's page is members-only.
      const forGuest = await h.thread('open-page', await h.viewer(), 'tab_a');
      expect(forGuest.comments[0]).toMatchObject({
        author: { kind: 'member', displayName: 'Name of anon-writer' },
        body: 'Hello there.',
        mine: false,
        source: 'member',
      });
      expect(forGuest.comments[0].author).not.toHaveProperty('slug');
      const forMember = await h.thread(
        'open-page',
        await h.viewer(U.named),
        'tab_a',
      );
      expect(forMember.comments[0].author).toEqual({
        kind: 'member',
        displayName: 'Name of anon-writer',
        slug: 'anon-writer',
      });
      const forAuthor = await h.thread(
        'open-page',
        await h.viewer(U.anon),
        'tab_a',
      );
      expect(forAuthor.comments[0]).toMatchObject({ mine: true, seq: 1 });
    });

    it('marks an admin with no page, and names no one whose page is gone', async () => {
      const h = harness();
      await h.commentsService.create(await h.writer(U.admin), {
        slug: 'open-page',
        body: 'From an admin.',
      });
      await h.commentsService.create(await h.writer(U.named), {
        slug: 'open-page',
        body: 'From a member who later left.',
      });
      await h.profiles
        .updateOne(
          { ownerUserId: U.named },
          { $set: { deletedAt: new Date() } },
        )
        .exec();
      const page = await h.thread('open-page', await h.viewer(), undefined);
      expect(page.comments.map((c) => c.author)).toEqual([
        { kind: 'admin' },
        { kind: 'member' },
      ]);
      expect(
        h.comments.docs.find((d) => d.authorUserId === U.admin),
      ).toMatchObject({ writtenAsAdmin: true });
    });

    it('attaches a reply to a reply to the top-level comment, in its thread', async () => {
      const h = harness();
      const writer = await h.writer(U.named);
      const reply = await h.commentsService.create(writer, {
        slug: 'imported-page',
        parentCommentId: 'cmt_imp3',
        body: 'Answering the deepest one.',
      });
      expect(
        h.comments.docs.find((d) => d.commentId === reply.commentId),
      ).toMatchObject({ parentCommentId: 'cmt_imp1', tabId: 'tab_i' });
      await expect(
        h.commentsService.create(writer, {
          slug: 'imported-page',
          tabId: 'tab_i',
          parentCommentId: 'cmt_imp1',
          body: 'Same thread, named.',
        }),
      ).resolves.toBeDefined();
    });

    it('refuses a reply naming another thread, a missing parent, or a removed one', async () => {
      const h = harness();
      const writer = await h.writer(U.named);
      await expect(
        h.commentsService.create(writer, {
          slug: 'imported-page',
          tabId: 'tab_other',
          parentCommentId: 'cmt_imp1',
          body: 'x',
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        h.commentsService.create(writer, {
          slug: 'open-page',
          parentCommentId: 'cmt_imp1',
          body: 'Parent is on another page.',
        }),
      ).rejects.toThrow(new NotFoundException(COMMENT_NOT_FOUND));
      const own = await h.commentsService.create(writer, {
        slug: 'open-page',
        body: 'Soon removed.',
      });
      await h.commentsService.remove(U.named, own.commentId);
      await expect(
        h.commentsService.create(writer, {
          slug: 'open-page',
          parentCommentId: own.commentId,
          body: 'Too late.',
        }),
      ).rejects.toThrow(new ConflictException(REPLY_TO_REMOVED));
    });

    it.each([
      ['a removed belief', 'open-page', 'tab_removed', U.named, NO_SUCH_BELIEF],
      ['an unlisted page', 'hidden-page', 'tab_h', U.named, PROFILE_NOT_FOUND],
      ['a pending page', 'waiting-page', 'tab_w', U.anon, PROFILE_NOT_FOUND],
      [
        'a members-only page, as an admin (allowed)',
        'members-page',
        'tab_m',
        U.admin,
        '',
      ],
    ])(
      'refuses a comment on %s',
      async (_name, slug, tabId, userId, message) => {
        const h = harness();
        const write = h.commentsService.create(await h.writer(userId), {
          slug,
          tabId,
          body: 'x',
        });
        if (message) await expect(write).rejects.toThrow(message);
        else await expect(write).resolves.toBeDefined();
      },
    );

    it('lets an anonymous member comment on a members-only page', async () => {
      const h = harness();
      await expect(
        h.commentsService.create(await h.writer(U.anon), {
          slug: 'members-page',
          tabId: 'tab_m',
          body: 'From a nickname.',
        }),
      ).resolves.toMatchObject({ seq: 1 });
    });

    it('refuses empty and too long text, as cleaned', async () => {
      const h = harness();
      const writer = await h.writer(U.named);
      await expect(
        h.commentsService.create(writer, {
          slug: 'open-page',
          body: '\u0007​ \n\n',
        }),
      ).rejects.toThrow(new BadRequestException(EMPTY_COMMENT));
      await expect(
        h.commentsService.create(writer, {
          slug: 'open-page',
          body: 'a'.repeat(MAX_COMMENT_LENGTH + 1),
        }),
      ).rejects.toThrow(new BadRequestException(COMMENT_TOO_LONG));
      await expect(
        h.commentsService.create(writer, {
          slug: 'open-page',
          body: `${'a'.repeat(MAX_COMMENT_LENGTH)}\u0000\u0000`,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('editing', () => {
    async function posted() {
      const h = harness();
      const writer = await h.writer(U.named);
      const { commentId } = await h.commentsService.create(writer, {
        slug: 'open-page',
        tabId: 'tab_a',
        body: 'First wording.',
      });
      return { h, writer, commentId };
    }

    it('appends a hash-chained version, shows "edited" and its history', async () => {
      const { h, writer, commentId } = await posted();
      await expect(
        h.commentsService.edit(writer, commentId, 'Second wording.', 1),
      ).resolves.toEqual({ changed: true, seq: 2 });
      await expect(
        h.commentsService.edit(writer, commentId, ' Second wording. ', 2),
      ).resolves.toEqual({ changed: false, seq: 2 });
      await expect(
        h.commentsService['versions'].verify(commentId),
      ).resolves.toMatchObject({ valid: true, length: 2 });
      expect(
        h.comments.docs.find((d) => d.commentId === commentId),
      ).toMatchObject({ body: 'Second wording.', bodySeq: 2 });

      const page = await h.thread('open-page', await h.viewer(), 'tab_a');
      expect(page.comments[0]).toMatchObject({
        body: 'Second wording.',
        edited: true,
        editedAt: expect.any(String),
      });
      const history = await h.commentsService.history(
        'open-page',
        commentId,
        await h.viewer(),
      );
      expect(history).toEqual({
        entries: [
          expect.objectContaining({ seq: 2, text: 'Second wording.' }),
          expect.objectContaining({ seq: 1, text: 'First wording.' }),
        ],
        page: 1,
        hasMore: false,
      });
      expect(history.entries[0].hash).toMatch(/^[0-9a-f]{12}$/);
    });

    it('refuses an edit based on an older version', async () => {
      const { h, writer, commentId } = await posted();
      await h.commentsService.edit(writer, commentId, 'Edit in window one.', 1);
      await expect(
        h.commentsService.edit(writer, commentId, 'Edit in window two.', 1),
      ).rejects.toThrow(new ConflictException(STALE_COMMENT_EDIT));
    });

    it('reads the version even when the copy on the row was not updated', async () => {
      const { h, writer, commentId } = await posted();
      const real = h.comments.updateOne;
      jest
        .spyOn(h.comments, 'updateOne')
        .mockImplementation((filter, update) =>
          '$set' in update && 'body' in (update.$set as object)
            ? { exec: () => Promise.reject(new Error('down')) }
            : real(filter, update),
        );
      await expect(
        h.commentsService.edit(writer, commentId, 'Saved anyway.', 1),
      ).resolves.toEqual({ changed: true, seq: 2 });
      const page = await h.thread('open-page', await h.viewer(), 'tab_a');
      expect(page.comments[0].body).toBe('Saved anyway.');
    });

    it("refuses someone else's comment, the page owner's too, with a 404", async () => {
      const { h, commentId } = await posted();
      for (const userId of [U.anon, U.owner]) {
        await expect(
          h.commentsService.edit(await h.writer(userId), commentId, 'Mine?', 1),
        ).rejects.toThrow(new NotFoundException(COMMENT_NOT_FOUND));
        await expect(
          h.commentsService.remove(userId, commentId),
        ).rejects.toThrow(new NotFoundException(COMMENT_NOT_FOUND));
      }
      await expect(
        h.commentsService.edit(await h.writer(U.named), 'cmt_imp1', 'x', 1),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses editing a removed comment, or one whose belief was removed', async () => {
      const { h, writer, commentId } = await posted();
      await h.tabs
        .updateOne({ tabId: 'tab_a' }, { $set: { removedAt: new Date() } })
        .exec();
      await expect(
        h.commentsService.edit(writer, commentId, 'x', 1),
      ).rejects.toThrow(new NotFoundException(NO_SUCH_BELIEF));
      await h.commentsService.remove(U.named, commentId);
      await expect(
        h.commentsService.edit(writer, commentId, 'x', 1),
      ).rejects.toThrow(new ConflictException(REMOVED_COMMENT));
    });

    it('refuses an edit once the author may no longer read the page', async () => {
      const { h, writer, commentId } = await posted();
      await h.profiles
        .updateOne({ slug: 'open-page' }, { $set: { visibility: 'unlisted' } })
        .exec();
      await expect(
        h.commentsService.edit(writer, commentId, 'x', 1),
      ).rejects.toThrow(new NotFoundException(PROFILE_NOT_FOUND));
      // Removing one's own words never depends on the page's settings.
      await expect(
        h.commentsService.remove(U.named, commentId),
      ).resolves.toEqual({ removed: true });
    });

    it('refuses an edit when the page itself is gone', async () => {
      const { h, writer, commentId } = await posted();
      h.profiles.docs.splice(
        h.profiles.docs.findIndex((d) => d.slug === 'open-page'),
        1,
      );
      await expect(
        h.commentsService.edit(writer, commentId, 'x', 1),
      ).rejects.toThrow(new NotFoundException(COMMENT_NOT_FOUND));
    });

    it('edits a page-level comment', async () => {
      const h = harness();
      const writer = await h.writer(U.named);
      const { commentId } = await h.commentsService.create(writer, {
        slug: 'open-page',
        body: 'About the page.',
      });
      await expect(
        h.commentsService.edit(writer, commentId, 'About the page, edited.', 1),
      ).resolves.toEqual({ changed: true, seq: 2 });
      await expect(
        h.commentsService.history('open-page', commentId, await h.viewer()),
      ).resolves.toMatchObject({ entries: [{ seq: 2 }, { seq: 1 }] });
    });
  });

  describe('removing', () => {
    it('keeps the text in the database and the place in the thread', async () => {
      const h = harness();
      const writer = await h.writer(U.named);
      const { commentId } = await h.commentsService.create(writer, {
        slug: 'open-page',
        tabId: 'tab_b',
        body: 'Said, then withdrawn.',
      });
      await h.commentsService.create(await h.writer(U.anon), {
        slug: 'open-page',
        parentCommentId: commentId,
        body: 'A reply that keeps its context.',
      });
      await expect(
        h.commentsService.remove(U.named, commentId),
      ).resolves.toEqual({ removed: true });
      await expect(
        h.commentsService.remove(U.named, commentId),
      ).resolves.toEqual({ removed: true });
      const stored = h.comments.docs.find((d) => d.commentId === commentId);
      expect(stored).toMatchObject({
        body: 'Said, then withdrawn.',
        removedBy: U.named,
        removedAt: expect.any(Date),
      });
      const page = await h.thread(
        'open-page',
        await h.viewer(U.named),
        'tab_b',
      );
      expect(page.comments[0]).toMatchObject({
        removed: true,
        mine: false,
        replies: [expect.objectContaining({ removed: false })],
      });
      expect(page.comments[0]).not.toHaveProperty('body');
      expect(JSON.stringify(page)).not.toContain('withdrawn');
      await expect(
        h.commentsService.history('open-page', commentId, await h.viewer()),
      ).rejects.toThrow(NotFoundException);
      // Counted no more; the reply still is.
      const profile = await h.members.profile('open-page', await h.viewer());
      expect(profile).toMatchObject({
        tabs: [
          expect.objectContaining({ tabId: 'tab_a', commentCount: 0 }),
          expect.objectContaining({ tabId: 'tab_b', commentCount: 1 }),
        ],
      });
    });
  });

  describe('robustness', () => {
    it('reads the row when a comment has no version, and logs any failure as text', async () => {
      const h = harness();
      const writer = await h.writer(U.named);
      const { commentId } = await h.commentsService.create(writer, {
        slug: 'open-page',
        body: 'Versions lost.',
      });
      h.commentVersions.docs.splice(0, h.commentVersions.docs.length);
      const page = await h.thread(
        'open-page',
        await h.viewer(U.named),
        undefined,
      );
      expect(page.comments[0]).toMatchObject({
        commentId,
        body: 'Versions lost.',
        seq: 1,
        edited: false,
      });
      expect(describeFailure('plain')).toBe('plain');
      expect(describeFailure(new Error('err'))).toBe('err');
    });
  });

  describe('history', () => {
    it('pages, and refuses imported comments, suggestions and other pages', async () => {
      const h = harness();
      const writer = await h.writer(U.named);
      const { commentId } = await h.commentsService.create(writer, {
        slug: 'open-page',
        tabId: 'tab_a',
        body: 'v1',
      });
      for (let seq = 1; seq <= 21; seq++) {
        await h.commentsService.edit(writer, commentId, `v${seq + 1}`, seq);
      }
      const viewer = await h.viewer();
      await expect(
        h.commentsService.history('open-page', commentId, viewer),
      ).resolves.toMatchObject({ hasMore: true, page: 1 });
      const second = await h.commentsService.history(
        'open-page',
        commentId,
        viewer,
        2,
      );
      expect(second).toMatchObject({ hasMore: false, page: 2 });
      expect(second.entries.map((e) => e.seq)).toEqual([2, 1]);

      for (const [slug, id] of [
        ['imported-page', 'cmt_imp1'],
        ['imported-page', commentId],
        ['open-page', 'cmt_none'],
      ]) {
        await expect(
          h.commentsService.history(slug, id, viewer),
        ).rejects.toThrow(new NotFoundException(COMMENT_NOT_FOUND));
      }
      await h.tabs
        .updateOne({ tabId: 'tab_a' }, { $set: { removedAt: new Date() } })
        .exec();
      await expect(
        h.commentsService.history('open-page', commentId, viewer),
      ).rejects.toThrow(new NotFoundException(NO_SUCH_BELIEF));
    });
  });
});
