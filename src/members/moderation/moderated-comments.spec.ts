// What a moderator's "hide" or "remove" does to comments everywhere a reader
// meets them (Chunk 13), with the real comment services over in-memory
// models. Synthetic data only.
import { ConflictException, NotFoundException } from '@nestjs/common';
import { commentCounts } from '../comments/comment-store';
import { visibleCounts } from '../comments/comment-threads';
import {
  harness,
  type Harness,
  U,
} from '../comments/comments-harness.mocks-spec';
import {
  MODERATED_COMMENT,
  REMOVED_COMMENT,
  REPLY_TO_MODERATED,
} from '../comments/comments.service';
import { SUGGESTION_MODERATED } from '../comments/suggestions.service';

const SECRET = 'Synthetic words a moderator hid.';

/** Sets a moderator's decision on a stored comment, as the queue does. */
function moderate(h: Harness, commentId: string, state: 'hidden' | 'removed') {
  const row = h.comments.docs.find((doc) => doc.commentId === commentId)!;
  Object.assign(row, {
    moderation: state,
    moderatedAt: new Date(),
    moderatedBy: U.admin,
  });
}

async function postAgreeing(h: Harness) {
  const writer = await h.writer(U.named);
  await h.votesService.cast(await h.viewer(U.named), {
    slug: 'open-page',
    tabId: 'tab_a',
    value: 'agree',
    baseSeq: 1,
  });
  const made = await h.commentsService.create(writer, {
    slug: 'open-page',
    tabId: 'tab_a',
    body: SECRET,
    stance: 'agree',
  });
  return made.commentId;
}

describe('a comment hidden or removed by a moderator (Chunk 13)', () => {
  it('keeps its place, but only an admin reads its text and badge', async () => {
    const h = harness();
    const commentId = await postAgreeing(h);
    const reply = await h.commentsService.create(await h.writer(U.anon), {
      slug: 'open-page',
      parentCommentId: commentId,
      body: 'A synthetic reply.',
    });
    moderate(h, commentId, 'hidden');

    const guest = await h.thread('open-page', await h.viewer(), 'tab_a');
    const [shown] = guest.comments;
    expect(shown).toMatchObject({
      commentId,
      moderated: 'hidden',
      removed: false,
      mine: false,
    });
    expect(shown).not.toHaveProperty('body');
    expect(shown).not.toHaveProperty('stance');
    expect(JSON.stringify(guest)).not.toContain(SECRET);
    // Replies stay, with their own text.
    expect(shown.replies?.[0]).toMatchObject({
      commentId: reply.commentId,
      body: 'A synthetic reply.',
    });

    const author = await h.thread(
      'open-page',
      await h.viewer(U.named),
      'tab_a',
    );
    expect(author.comments[0]).toMatchObject({
      moderated: 'hidden',
      mine: true,
    });
    // No edit offered: `seq` is what offers one.
    expect(author.comments[0]).not.toHaveProperty('seq');
    expect(JSON.stringify(author)).not.toContain(SECRET);

    const admin = await h.thread('open-page', await h.viewer(U.admin), 'tab_a');
    expect(admin.comments[0]).toMatchObject({
      moderated: 'hidden',
      body: SECRET,
      stance: 'agree',
    });
  });

  it('says "removed" for a removal, and the author’s own removal still wins', async () => {
    const h = harness();
    const commentId = await postAgreeing(h);
    moderate(h, commentId, 'removed');
    const viewOne = await h.commentsService.viewOne(
      commentId,
      await h.viewer(U.admin),
    );
    expect(viewOne).toMatchObject({ moderated: 'removed', body: SECRET });
    await h.commentsService.remove(U.named, commentId);
    const after = await h.commentsService.viewOne(
      commentId,
      await h.viewer(U.admin),
    );
    expect(after).toMatchObject({ removed: true, moderated: 'removed' });
    expect(after).not.toHaveProperty('body');
  });

  it('is not counted on the page', async () => {
    const h = harness();
    const commentId = await postAgreeing(h);
    const profileId = h.comments.docs.find(
      (doc) => doc.commentId === commentId,
    )!.profileId as never;
    expect(
      (await commentCounts(h.comments as never, profileId)).get('tab_a'),
    ).toBe(1);
    moderate(h, commentId, 'hidden');
    expect(
      (await commentCounts(h.comments as never, profileId)).get('tab_a'),
    ).toBeUndefined();
    expect(
      visibleCounts([
        { commentId: 'a', tabId: 't' },
        { commentId: 'b', tabId: 't', moderation: 'removed' },
      ]).get('t'),
    ).toBe(1);
  });

  it('cannot be edited or answered, but its author can still take it down', async () => {
    const h = harness();
    const commentId = await postAgreeing(h);
    moderate(h, commentId, 'hidden');
    const writer = await h.writer(U.named);
    await expect(
      h.commentsService.edit(writer, commentId, 'New words.', 1),
    ).rejects.toThrow(new ConflictException(MODERATED_COMMENT));
    await expect(
      h.commentsService.create(await h.writer(U.anon), {
        slug: 'open-page',
        parentCommentId: commentId,
        body: 'A reply.',
      }),
    ).rejects.toThrow(new ConflictException(REPLY_TO_MODERATED));
    await expect(h.commentsService.remove(U.named, commentId)).resolves.toEqual(
      { removed: true },
    );
  });

  it('refuses an edit whose turn the decision beat, with the right reason', async () => {
    const h = harness();
    const commentId = await postAgreeing(h);
    const writer = await h.writer(U.named);
    const take = jest.spyOn(h.store, 'takeEditTurn');

    // Hidden between the check and the turn.
    take.mockImplementationOnce(() => {
      moderate(h, commentId, 'hidden');
      return Promise.resolve(undefined);
    });
    await expect(
      h.commentsService.edit(writer, commentId, 'New words.', 1),
    ).rejects.toThrow(new ConflictException(MODERATED_COMMENT));

    // Removed by its author as well: that is what it says.
    const other = await h.commentsService.create(writer, {
      slug: 'open-page',
      tabId: 'tab_b',
      body: 'Second synthetic comment.',
    });
    take.mockImplementationOnce(async () => {
      moderate(h, other.commentId, 'hidden');
      await h.store.removeWhenFree(other.commentId, U.named, {});
      return undefined;
    });
    await expect(
      h.commentsService.edit(writer, other.commentId, 'New words.', 1),
    ).rejects.toThrow(new ConflictException(REMOVED_COMMENT));

    // Gone entirely between the check and the turn.
    const third = await h.commentsService.create(writer, {
      slug: 'open-page',
      tabId: 'tab_b',
      body: 'Third synthetic comment.',
    });
    take.mockImplementationOnce(() => {
      const index = h.comments.docs.findIndex(
        (doc) => doc.commentId === third.commentId,
      );
      h.comments.docs.splice(index, 1);
      return Promise.resolve(undefined);
    });
    await expect(
      h.commentsService.edit(writer, third.commentId, 'New words.', 1),
    ).rejects.toThrow(new ConflictException(REMOVED_COMMENT));
  });

  it('never takes an edit turn while a decision stands', async () => {
    const h = harness();
    const commentId = await postAgreeing(h);
    moderate(h, commentId, 'hidden');
    await expect(
      h.store.takeEditTurn(commentId, U.named),
    ).resolves.toBeUndefined();
  });

  it('has a history only an admin can read', async () => {
    const h = harness();
    const commentId = await postAgreeing(h);
    await h.commentsService.edit(
      await h.writer(U.named),
      commentId,
      'Edited synthetic words.',
      1,
    );
    moderate(h, commentId, 'hidden');
    for (const userId of [undefined, U.named, U.owner]) {
      await expect(
        h.commentsService.history(
          'open-page',
          commentId,
          await h.viewer(userId),
        ),
      ).rejects.toThrow(NotFoundException);
    }
    const history = await h.commentsService.history(
      'open-page',
      commentId,
      await h.viewer(U.admin),
    );
    expect(history.entries.map((entry) => entry.text)).toEqual([
      'Edited synthetic words.',
      SECRET,
    ]);
  });

  it('on an ORG page: hidden from readers and their history, read by admins', async () => {
    const h = harness();
    const made = await h.commentsService.createOnOrgPage(
      await h.writer(U.named),
      { pageId: 'about', body: SECRET },
    );
    moderate(h, made.commentId, 'removed');
    const guest = await h.commentsService.orgThread(
      'about',
      await h.viewer(),
      undefined,
      { mayComment: false, block: 'sign-in' },
    );
    expect(guest.comments[0]).toMatchObject({ moderated: 'removed' });
    expect(JSON.stringify(guest)).not.toContain(SECRET);
    // Without a reader, the history is a guest's.
    await expect(
      h.commentsService.orgHistory('about', made.commentId),
    ).rejects.toThrow(NotFoundException);
    const admin = await h.commentsService.orgHistory(
      'about',
      made.commentId,
      1,
      await h.viewer(U.admin),
    );
    expect(admin.entries[0].text).toBe(SECRET);
  });

  it('as a suggestion: no proposed text for readers, and it cannot be accepted', async () => {
    const h = harness();
    const { commentId } = await h.suggestions.suggest(await h.writer(U.named), {
      slug: 'open-page',
      tabId: 'tab_a',
      text: SECRET,
      baseSeq: 1,
    });
    moderate(h, commentId, 'hidden');
    const owner = await h.commentsService.viewOne(
      commentId,
      await h.viewer(U.owner),
      true,
    );
    expect(owner?.suggestion).toMatchObject({
      status: 'pending',
      canDecide: false,
    });
    expect(owner?.suggestion).not.toHaveProperty('proposedText');
    const admin = await h.commentsService.viewOne(
      commentId,
      await h.viewer(U.admin),
    );
    expect(admin?.suggestion?.proposedText).toBe(SECRET);
    await expect(h.suggestions.accept(U.owner, commentId)).rejects.toThrow(
      new ConflictException(SUGGESTION_MODERATED),
    );
    // Declining stays possible.
    await expect(h.suggestions.decline(U.owner, commentId)).resolves.toEqual(
      expect.objectContaining({ declined: true }),
    );
  });

  it('confirms Chunk 9: no member path removes someone else’s comment', async () => {
    const h = harness();
    const commentId = await postAgreeing(h);
    for (const userId of [U.owner, U.anon, U.admin]) {
      await expect(h.commentsService.remove(userId, commentId)).rejects.toThrow(
        NotFoundException,
      );
    }
    expect(
      h.comments.docs.find((doc) => doc.commentId === commentId)!.removedAt,
    ).toBeUndefined();
  });
});
