// Chunk 9 independent review, round 2: one test (or more) per item.
import { NotFoundException } from '@nestjs/common';
import { takeTextTurn } from '../tab-text-turns';
import { harness, ids, U } from './comments-harness.mocks-spec';

type H = ReturnType<typeof harness>;

/** A site comment whose writing stopped before its confirm. */
function unconfirmed(h: H, commentId: string, extra: object = {}) {
  h.comments.docs.push({
    commentId,
    profileId: ids.open,
    tabId: 'tab_a',
    authorUserId: U.named,
    body: 'Secret unconfirmed text.',
    source: 'native',
    kind: 'comment',
    createdAt: new Date(),
    ...extra,
  });
}

describe('round 2 item 1: an imported reply whose parent is missing is listed and counted alike', () => {
  it('is a top-level comment in its thread, and the tab count matches what is listed', async () => {
    const h = harness();
    h.comments.docs.push({
      commentId: 'cmt_orphan',
      profileId: ids.imported,
      tabId: 'tab_i',
      parentCommentId: 'cmt_never_imported',
      legacyAuthorName: 'Synthetic Pages Author',
      body: 'An imported reply whose parent was not imported.',
      source: 'migrated',
      createdAt: new Date(Date.UTC(2026, 9, 1, 12, 30)),
    });
    const viewer = await h.viewer();
    const page = await h.thread('imported-page', viewer, 'tab_i');
    const listed =
      page.comments.length +
      page.comments.reduce((n, c) => n + (c.replies?.length ?? 0), 0);
    expect(page.comments.map((c) => c.commentId)).toEqual([
      'cmt_imp1',
      'cmt_orphan',
    ]);
    const profile = await h.members.profile('imported-page', viewer);
    expect(profile).toMatchObject({
      tabs: [expect.objectContaining({ commentCount: listed })],
    });
    expect(listed).toBe(4);
    // A reply to it attaches to it.
    const reply = await h.commentsService.create(await h.writer(U.named), {
      slug: 'imported-page',
      parentCommentId: 'cmt_orphan',
      body: 'Answering the orphan.',
    });
    const again = await h.thread('imported-page', viewer, 'tab_i');
    expect(again.comments[1].replies?.map((r) => r.commentId)).toEqual([
      reply.commentId,
    ]);
  });
});

describe('round 2 item 7: history names an admin suggestion as the thread does', () => {
  it('says "ORG admin" for a suggestion written as an admin', async () => {
    const h = harness();
    const { commentId } = await h.suggestions.suggest(await h.writer(U.admin), {
      slug: 'open-page',
      tabId: 'tab_a',
      text: 'An admin wording.',
      baseSeq: 1,
    });
    await h.suggestions.accept(U.owner, commentId);
    const history = await h.history.tabHistory(
      'open-page',
      'tab_a',
      await h.viewer(),
    );
    expect(history.entries[0].fromSuggestion).toEqual({
      commentId,
      author: { kind: 'admin' },
    });
    const thread = await h.thread('open-page', await h.viewer(), 'tab_a');
    expect(thread.comments[0].author).toEqual({ kind: 'admin' });
  });
});

describe('round 2 item 8: an unconfirmed comment is nowhere', () => {
  it('cannot be replied to, read in history, removed or edited (n1)', async () => {
    const h = harness();
    unconfirmed(h, 'cmt_unconfirmed');
    const writer = await h.writer(U.named);
    await expect(
      h.commentsService.create(writer, {
        slug: 'open-page',
        parentCommentId: 'cmt_unconfirmed',
        body: 'A reply.',
      }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      h.commentsService.history(
        'open-page',
        'cmt_unconfirmed',
        await h.viewer(),
      ),
    ).rejects.toThrow(NotFoundException);
    await expect(
      h.commentsService.remove(U.named, 'cmt_unconfirmed'),
    ).rejects.toThrow(NotFoundException);
    await expect(
      h.commentsService.edit(writer, 'cmt_unconfirmed', 'x', 1),
    ).rejects.toThrow(NotFoundException);
  });

  it('is never listed as a reply (n17)', async () => {
    const h = harness();
    const { commentId } = await h.commentsService.create(
      await h.writer(U.named),
      { slug: 'open-page', tabId: 'tab_a', body: 'Root.' },
    );
    unconfirmed(h, 'cmt_unconfirmed_reply', { parentCommentId: commentId });
    const page = await h.thread('open-page', await h.viewer(), 'tab_a');
    expect(page.comments[0].replies).toEqual([]);
    expect(JSON.stringify(page)).not.toContain('Secret unconfirmed');
  });

  it('cannot be accepted as a suggestion (n18)', async () => {
    const h = harness();
    unconfirmed(h, 'cmt_unconfirmed_suggestion', {
      kind: 'suggestion',
      body: '',
      suggestion: {
        proposedText: 'Never confirmed.',
        baseSeq: 1,
        status: 'pending',
      },
    });
    await expect(
      h.suggestions.accept(U.owner, 'cmt_unconfirmed_suggestion'),
    ).rejects.toThrow(NotFoundException);
    await expect(
      h.suggestions.decline(U.owner, 'cmt_unconfirmed_suggestion'),
    ).rejects.toThrow(NotFoundException);
  });

  it('gives no text turn on a removed belief (n8)', async () => {
    const h = harness();
    await expect(
      takeTextTurn(h.tabs as never, ids.open, 'tab_removed'),
    ).resolves.toBeUndefined();
    await expect(
      takeTextTurn(h.tabs as never, ids.open, 'tab_a'),
    ).resolves.toEqual(expect.any(String));
  });
});

describe('round 2 item 3: a write answers with its comment', () => {
  it('builds the writer view of one comment, and nothing for a missing one', async () => {
    const h = harness();
    const writer = await h.writer(U.named);
    const { commentId } = await h.commentsService.create(writer, {
      slug: 'open-page',
      tabId: 'tab_a',
      body: 'Mine.',
    });
    await expect(
      h.commentsService.viewOne(commentId, writer),
    ).resolves.toMatchObject({ commentId, body: 'Mine.', mine: true, seq: 1 });
    await expect(
      h.commentsService.viewOne('cmt_none', writer),
    ).resolves.toBeUndefined();
  });
});
