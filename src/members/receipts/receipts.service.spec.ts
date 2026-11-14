// Receipts (Chunk 16) over the REAL members services (comments harness):
// who may have one is decided by the history's own access code, and a
// receipt names nobody. Every name and text is synthetic.
import { Logger, NotFoundException } from '@nestjs/common';
import { fakeModel } from '../../test-support/fake-model.mocks-spec';
import {
  type AnchorModels,
  offlineAnchoring,
  verifierFor,
  withAnchorQueries,
} from '../../anchoring/anchoring-harness.mocks-spec';
import { makeTestTsa } from '../../anchoring/test-tsa.mocks-spec';
import { harness, U } from '../comments/comments-harness.mocks-spec';
import {
  COMMENT_NOT_FOUND,
  COMMENT_VERSION_NOT_FOUND,
} from '../comments/comments.service';
import { VERSION_NOT_FOUND } from '../member-history.service';
import { PROFILE_NOT_FOUND } from '../members.service';
import { CommentAuthorsService } from '../comments/comment-authors.service';
import { ReceiptsService } from './receipts.service';

const tsa = makeTestTsa();

function setUp() {
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
  const h = harness();
  const leaves = withAnchorQueries(fakeModel([], { unique: [['_id']] }));
  const m: AnchorModels = {
    anchors: withAnchorQueries(fakeModel([], { unique: [['_id']] })),
    leaves,
    blocks: withAnchorQueries(h.versions, () => leaves),
    comments: withAnchorQueries(h.commentVersions, () => leaves),
  };
  const receipts = new ReceiptsService(
    h.history,
    h.commentsService,
    verifierFor(m, tsa),
    new CommentAuthorsService(h.profiles as never),
  );
  // Comments are saved at the real time: anchor a little after it.
  const anchor = () =>
    offlineAnchoring(m, tsa).run(new Date(Date.now() + 10 * 60_000));
  return { h, m, receipts, anchor };
}

const notFound = (message: string) => new NotFoundException(message);

describe('belief receipts follow the history access rules', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a guest gets one for a public belief: the text as recorded, anchored, naming nobody', async () => {
    const { h, receipts, anchor } = setUp();
    const pending = await receipts.belief(
      'open-page',
      'tab_a',
      await h.viewer(),
    );
    expect(pending.versions[0].anchor.state).toBe('pending');
    await anchor();
    const receipt = await receipts.belief(
      'open-page',
      'tab_a',
      await h.viewer(),
    );
    expect(receipt.subject).toEqual({
      type: 'belief-text',
      page: 'open-page',
      tabId: 'tab_a',
    });
    const [version] = receipt.versions;
    expect(version).toMatchObject({
      text: 'Synthetic belief A.',
      imported:
        'imported from Apple Pages; originally written before 2026-11-01',
      anchor: {
        state: 'anchored',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- a matcher
        anchorId: expect.stringMatching(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
      },
    });
    expect(
      version.anchor.state === 'anchored' &&
        version.anchor.serverChecks.path.outcome,
    ).toBe('pass');
    expect(JSON.stringify(receipt)).not.toMatch(/user_|Name of/);
  });

  it.each<[string, string, string | undefined, boolean]>([
    ['members-only, guest', 'members-page', undefined, false],
    ['members-only, member', 'members-page', U.named, true],
    ['private (unlisted), member', 'hidden-page', U.named, false],
    ['private (unlisted), owner', 'hidden-page', U.hiddenOwner, true],
    ['private (unlisted), admin', 'hidden-page', U.admin, true],
    ['pending, guest', 'waiting-page', undefined, false],
    ['pending, owner', 'waiting-page', U.waiting, true],
    ['deleted page, admin', 'gone-page', U.admin, false],
  ])('%s', async (_, slug, reader, allowed) => {
    const { h, receipts } = setUp();
    const tabOf: Record<string, string> = {
      'members-page': 'tab_m',
      'hidden-page': 'tab_h',
      'waiting-page': 'tab_w',
      'gone-page': 'tab_x',
    };
    const result = receipts.belief(slug, tabOf[slug], await h.viewer(reader));
    if (allowed) {
      expect((await result).versions).toHaveLength(1);
    } else {
      await expect(result).rejects.toThrow(notFound(PROFILE_NOT_FOUND));
    }
  });

  it('a page an admin removed (moderated) is for admins only, its owner included out', async () => {
    const { h, receipts } = setUp();
    await h.profiles
      .updateOne({ slug: 'open-page' }, { $set: { reviewStatus: 'removed' } })
      .exec();
    for (const reader of [undefined, U.named, U.owner]) {
      await expect(
        receipts.belief('open-page', 'tab_a', await h.viewer(reader)),
      ).rejects.toThrow(notFound(PROFILE_NOT_FOUND));
    }
    expect(
      (await receipts.belief('open-page', 'tab_a', await h.viewer(U.admin)))
        .versions,
    ).toHaveLength(1);
  });

  it('a removed belief: its owner and admins only', async () => {
    const { h, receipts } = setUp();
    await expect(
      receipts.belief('open-page', 'tab_removed', await h.viewer(U.named)),
    ).rejects.toThrow(notFound(PROFILE_NOT_FOUND));
    // Reachable for the owner: it has no text, so no version.
    await expect(
      receipts.belief('open-page', 'tab_removed', await h.viewer(U.owner)),
    ).rejects.toThrow(notFound(VERSION_NOT_FOUND));
    await expect(
      receipts.belief('open-page', 'no_such_tab', await h.viewer(U.owner)),
    ).rejects.toThrow(notFound(PROFILE_NOT_FOUND));
  });

  it('an imported belief of several paragraphs is all of them, each labelled', async () => {
    const { h, receipts } = setUp();
    const receipt = await receipts.belief(
      'imported-page',
      'tab_i',
      await h.viewer(),
    );
    expect(receipt.versions.map((v) => [v.outlineLabel, v.text])).toEqual([
      ['I.', 'First part.'],
      ['A.', 'Second part.'],
    ]);
  });

  it('the current text after an edit, or any earlier one by seq; the owner may recompute it', async () => {
    const { h, receipts, anchor } = setUp();
    await h.editor.editTabText(U.owner, 'tab_a', 'The owner rewrote it.', 1);
    await anchor();
    const owner = await h.viewer(U.owner);
    const current = await receipts.belief('open-page', 'tab_a', owner);
    expect(current.versions[0]).toMatchObject({
      seq: 2,
      text: 'The owner rewrote it.',
    });
    expect(current.versions[0].hashInput.included).toBe(true);
    // The owner's page is public and named: a guest may know who wrote it,
    // so gets the hashes, but never the Clerk id in the hash input (round 3).
    const guest = await receipts.belief('open-page', 'tab_a', await h.viewer());
    expect(guest.versions[0].hashInput).toMatchObject({ included: false });
    expect(guest.versions[0].disclosure).toBe('hashes');
    expect(guest.versions[0].versionHash).toBeDefined();
    const first = await receipts.belief('open-page', 'tab_a', owner, 'text', 1);
    expect(first.versions[0]).toMatchObject({
      seq: 1,
      text: 'Synthetic belief A.',
    });
    await expect(
      receipts.belief('open-page', 'tab_a', owner, 'text', 9),
    ).rejects.toThrow(notFound(VERSION_NOT_FOUND));
  });

  it('a title receipt is its title history', async () => {
    const { h, receipts } = setUp();
    await expect(
      receipts.belief('open-page', 'tab_a', await h.viewer(), 'title'),
    ).rejects.toThrow(notFound(VERSION_NOT_FOUND));
    await h.editor.editTabTitle(U.owner, 'tab_a', 'A new title', 0);
    const receipt = await receipts.belief(
      'open-page',
      'tab_a',
      await h.viewer(),
      'title',
    );
    expect(receipt.subject.type).toBe('belief-title');
    expect(receipt.versions.map((v) => v.text)).toContain('A new title');
  });
});

describe('comment receipts follow the comment history rules', () => {
  afterEach(() => jest.restoreAllMocks());

  async function posted(
    h: ReturnType<typeof setUp>['h'],
    slug = 'open-page',
    tabId = 'tab_a',
  ) {
    return h.commentsService.create(await h.writer(U.named), {
      slug,
      tabId,
      body: 'A synthetic comment.',
    });
  }

  it('a reader of the thread gets one; the author can recompute its hash, others cannot', async () => {
    const { h, receipts, anchor } = setUp();
    // By an anonymous member: nobody else may know who wrote it.
    const { commentId } = await h.commentsService.create(
      await h.writer(U.anon),
      { slug: 'open-page', tabId: 'tab_a', body: 'A synthetic comment.' },
    );
    await anchor();
    const guest = await receipts.comment(
      'open-page',
      commentId,
      await h.viewer(),
    );
    expect(guest.subject).toEqual({
      type: 'comment',
      page: 'open-page',
      commentId,
    });
    expect(guest.versions[0]).toMatchObject({
      kind: 'comment',
      text: 'A synthetic comment.',
      hashInput: { included: false },
      anchor: { state: 'anchored' },
    });
    expect(JSON.stringify(guest)).not.toContain(U.anon);
    const author = await receipts.comment(
      'open-page',
      commentId,
      await h.viewer(U.anon),
    );
    expect(author.versions[0].hashInput.included).toBe(true);
    await expect(
      receipts.comment('open-page', commentId, await h.viewer(), 7),
    ).rejects.toThrow(notFound(COMMENT_VERSION_NOT_FOUND));
  });

  it('on a members-only page: members only', async () => {
    const { h, receipts } = setUp();
    const { commentId } = await posted(h, 'members-page', 'tab_m');
    await expect(
      receipts.comment('members-page', commentId, await h.viewer()),
    ).rejects.toThrow(notFound(PROFILE_NOT_FOUND));
    expect(
      (
        await receipts.comment(
          'members-page',
          commentId,
          await h.viewer(U.anon),
        )
      ).versions,
    ).toHaveLength(1);
  });

  it('a comment hidden by a moderator: admins only; removed by its author: nobody', async () => {
    const { h, receipts } = setUp();
    const { commentId } = await posted(h);
    await h.comments
      .updateOne({ commentId }, { $set: { moderation: 'hidden' } })
      .exec();
    await expect(
      receipts.comment('open-page', commentId, await h.viewer(U.owner)),
    ).rejects.toThrow(notFound(COMMENT_NOT_FOUND));
    expect(
      (await receipts.comment('open-page', commentId, await h.viewer(U.admin)))
        .versions,
    ).toHaveLength(1);
    await h.comments
      .updateOne(
        { commentId },
        { $set: { removedAt: new Date() }, $unset: { moderation: 1 } },
      )
      .exec();
    await expect(
      receipts.comment('open-page', commentId, await h.viewer(U.admin)),
    ).rejects.toThrow(notFound(COMMENT_NOT_FOUND));
  });

  it('an imported comment has no version, so no receipt; nor one on another page', async () => {
    const { h, receipts } = setUp();
    await expect(
      receipts.comment('imported-page', 'cmt_imp1', await h.viewer()),
    ).rejects.toThrow(notFound(COMMENT_NOT_FOUND));
    const { commentId } = await posted(h);
    await expect(
      receipts.comment('named-writer', commentId, await h.viewer()),
    ).rejects.toThrow(notFound(COMMENT_NOT_FOUND));
  });

  it('a comment on one of ORG’s own pages', async () => {
    const { h, receipts, anchor } = setUp();
    const { commentId } = await h.commentsService.createOnOrgPage(
      await h.writer(U.named),
      {
        pageId: 'about',
        body: 'A synthetic comment on an ORG page.',
      },
    );
    await anchor();
    const receipt = await receipts.orgComment(
      'about',
      commentId,
      await h.viewer(),
    );
    expect(receipt.subject).toEqual({
      type: 'org-page-comment',
      orgPage: 'about',
      commentId,
    });
    expect(receipt.versions[0].anchor.state).toBe('anchored');
    await expect(
      receipts.orgComment('research', commentId, await h.viewer()),
    ).rejects.toThrow(notFound(COMMENT_NOT_FOUND));
  });
});
