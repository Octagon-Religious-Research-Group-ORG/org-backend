// Where comments, suggestions and votes tell people (Chunk 14): each action
// reports itself to the notifier after it is saved, with what the notifier
// needs to decide who hears of it. Synthetic data only.
import { harness, ids, U } from './comments-harness.mocks-spec';

function notifier() {
  return {
    commentPosted: jest.fn(() => Promise.resolve()),
    suggestionPosted: jest.fn(() => Promise.resolve()),
    suggestionDecided: jest.fn(() => Promise.resolve()),
    beliefAgreed: jest.fn(() => Promise.resolve()),
  };
}

describe('notifications from comments, suggestions and votes (Chunk 14)', () => {
  it('reports a comment with its page owner, and a reply with the answered author', async () => {
    const n = notifier();
    const h = harness({ notifier: n });
    const { commentId } = await h.commentsService.create(
      await h.writer(U.named),
      { slug: 'open-page', tabId: 'tab_a', body: 'Synthetic words.' },
    );
    expect(n.commentPosted).toHaveBeenLastCalledWith({
      commentId,
      actorUserId: U.named,
      profileId: ids.open,
      tabId: 'tab_a',
      pageOwnerUserId: U.owner,
      parentAuthorUserId: undefined,
    });
    const reply = await h.commentsService.create(await h.writer(U.anon), {
      slug: 'open-page',
      body: 'Synthetic reply.',
      parentCommentId: commentId,
    });
    expect(n.commentPosted).toHaveBeenLastCalledWith(
      expect.objectContaining({
        commentId: reply.commentId,
        actorUserId: U.anon,
        pageOwnerUserId: U.owner,
        parentAuthorUserId: U.named,
      }),
    );
  });

  it('names the account an imported comment is linked to, and nobody for one that is not', async () => {
    const n = notifier();
    const h = harness({ notifier: n });
    await h.commentsService.create(await h.writer(U.named), {
      slug: 'imported-page',
      body: 'Synthetic reply.',
      parentCommentId: 'cmt_imp1',
    });
    expect(n.commentPosted).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pageOwnerUserId: undefined,
        parentAuthorUserId: undefined,
      }),
    );
    h.comments.docs.find((d) => d.commentId === 'cmt_imp1')!.linkedUserId =
      U.owner;
    await h.commentsService.create(await h.writer(U.named), {
      slug: 'imported-page',
      body: 'Synthetic reply.',
      parentCommentId: 'cmt_imp1',
    });
    expect(n.commentPosted).toHaveBeenLastCalledWith(
      expect.objectContaining({ parentAuthorUserId: U.owner }),
    );
  });

  it('reports a comment on an ORG page with no owner', async () => {
    const n = notifier();
    const h = harness({ notifier: n });
    await h.commentsService.createOnOrgPage(await h.writer(U.named), {
      pageId: 'about',
      body: 'Synthetic words.',
    });
    expect(n.commentPosted).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'org-page:about',
        pageOwnerUserId: undefined,
      }),
    );
  });

  it('reports a suggestion to the owner, and its decision to its author', async () => {
    const n = notifier();
    const h = harness({ notifier: n });
    const suggest = async (tabId: string) =>
      (
        await h.suggestions.suggest(await h.writer(U.named), {
          slug: 'open-page',
          tabId,
          text: `Synthetic rewording of ${tabId}.`,
          baseSeq: 1,
        })
      ).commentId;
    const first = await suggest('tab_a');
    expect(n.suggestionPosted).toHaveBeenCalledWith({
      commentId: first,
      actorUserId: U.named,
      ownerUserId: U.owner,
    });
    await h.suggestions.accept(U.owner, first);
    expect(n.suggestionDecided).toHaveBeenLastCalledWith({
      commentId: first,
      actorUserId: U.owner,
      suggesterUserId: U.named,
    });
    const second = await suggest('tab_b');
    await h.suggestions.decline(U.owner, second);
    expect(n.suggestionDecided).toHaveBeenLastCalledWith({
      commentId: second,
      actorUserId: U.owner,
      suggesterUserId: U.named,
    });
    expect(n.suggestionDecided).toHaveBeenCalledTimes(2);
  });

  it('reports the agree that puts a belief on the agreed list, and not before', async () => {
    const n = notifier();
    const h = harness({ notifier: n });
    const cast = async (userId: string, value: 'agree' | 'disagree') =>
      h.votesService.cast(await h.viewer(userId), {
        slug: 'open-page',
        tabId: 'tab_a',
        value,
        baseSeq: 1,
      });
    await cast(U.named, 'agree');
    expect(n.beliefAgreed).not.toHaveBeenCalled();
    await cast(U.membersOwner, 'disagree');
    expect(n.beliefAgreed).not.toHaveBeenCalled();
    await cast(U.membersOwner, 'agree');
    expect(n.beliefAgreed).toHaveBeenCalledWith({
      profileId: ids.open,
      tabId: 'tab_a',
      textSeq: 1,
      ownerUserId: U.owner,
      actorUserId: U.membersOwner,
    });
  });
});
