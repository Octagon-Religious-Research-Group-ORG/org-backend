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
import {
  PURGED_SUGGESTER_CHECK,
  PURGED_SUGGESTER_PENDING_CHECK,
} from '../../anchoring/anchor-verifier.service';
import { PurgeMarksService } from '../../anchoring/purge-marks.service';
import { toRecord } from '../../anchoring/version-records';
import {
  buildReceipt,
  PURGED_AND_WITHHELD_LINE,
  PURGED_HASH_REASON,
  PURGED_RECEIPT_NOTICE,
} from '../../anchoring/receipt';
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
  const marks = new PurgeMarksService(
    h.profiles as never,
    h.blocks as never,
    h.tabs as never,
    h.comments as never,
    h.commentVersions as never,
    m.leaves as never,
    m.anchors as never,
  );
  const receipts = new ReceiptsService(
    h.history,
    h.commentsService,
    verifierFor(m, tsa, marks),
    new CommentAuthorsService(h.profiles as never),
  );
  // Comments are saved at the real time: anchor a little after it.
  const anchor = () =>
    offlineAnchoring(m, tsa).run(new Date(Date.now() + 10 * 60_000));
  return { h, m, receipts, anchor, marks };
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

  it('gives the export the same disclosure rule, also after the page is deleted (Chunk 17)', async () => {
    const { h, receipts, anchor } = setUp();
    const { commentId } = await h.commentsService.create(
      await h.writer(U.anon),
      { slug: 'open-page', tabId: 'tab_a', body: 'A synthetic comment.' },
    );
    await anchor();
    await h.profiles
      .updateOne({ ownerUserId: U.anon }, { $set: { deletedAt: new Date() } })
      .exec();
    const row = h.commentVersions.docs.find(
      (doc) => doc.commentId === commentId,
    ) as never;
    const subject = { type: 'comment', page: 'open-page', commentId } as const;
    const own = await receipts.exportVersion('comment', row, subject, {
      kind: 'signed-in',
      userId: U.anon,
      isAdmin: false,
    });
    expect(own.subject).toEqual(subject);
    expect(own.versions[0]).toMatchObject({
      disclosure: 'full',
      hashInput: { included: true },
      anchor: { state: 'anchored' },
    });
    // The same row read by anyone else: the leaf and proofs only.
    const other = await receipts.exportVersion(
      'comment',
      row,
      subject,
      await h.viewer(U.named),
    );
    expect(other.versions[0].disclosure).toBe('none');
    expect(JSON.stringify(other)).not.toContain(U.anon);
  });

  // A purged member's comment in another member's thread (open-page).
  async function purgedComment(
    markComment: boolean,
    shape: Record<string, unknown> = {},
  ) {
    const setup = setUp();
    const { h, anchor } = setup;
    const { commentId } = await h.commentsService.create(
      await h.writer(U.named),
      { slug: 'open-page', tabId: 'tab_a', body: 'A synthetic comment.' },
    );
    await anchor();
    const row = h.commentVersions.docs.find(
      (doc) => doc.commentId === commentId,
    )!;
    Object.assign(row, {
      text: '',
      authorUserId: 'system:purged',
      purgedAt: new Date(),
      ...shape,
    });
    if (markComment) {
      const comment = h.comments.docs.find((d) => d.commentId === commentId)!;
      comment.purgedAt = new Date();
    }
    return { ...setup, commentId, row };
  }
  const hashOutcome = (receipt: { versions: Array<{ anchor: unknown }> }) =>
    (
      receipt.versions[0].anchor as {
        serverChecks: Record<string, { outcome: string }>;
      }
    ).serverChecks.hash.outcome;

  it('reads purgedAt as nothing unless the shape and the owner mark agree (review #2)', async () => {
    // Carries purgedAt, but its comment was never marked: a tampered row.
    const unmarked = await purgedComment(false);
    expect(
      hashOutcome(
        await unmarked.receipts.comment(
          'open-page',
          unmarked.commentId,
          await unmarked.h.viewer(),
        ),
      ),
    ).toBe('fail');
    // Marked, but its text was rewritten rather than removed.
    const rewritten = await purgedComment(true, { text: 'Other words.' });
    expect(
      hashOutcome(
        await rewritten.receipts.comment(
          'open-page',
          rewritten.commentId,
          await rewritten.h.viewer(),
        ),
      ),
    ).toBe('fail');
    // Marked, but a real person in place of the purged one.
    const person = await purgedComment(true, { authorUserId: U.owner });
    expect(
      hashOutcome(
        await person.receipts.comment(
          'open-page',
          person.commentId,
          await person.h.viewer(),
        ),
      ),
    ).toBe('fail');
  });

  it('reports a version whose only change is a purged suggester as cannot-measure (review #4)', async () => {
    const { h, m, commentId, row } = await purgedComment(true);
    // The row as a live version keeps it: text and author intact.
    Object.assign(row, { text: 'A synthetic comment.', authorUserId: U.named });
    const verifier = verifierFor(m, tsa, {
      classify: () => Promise.resolve('suggester'),
    } as never);
    const record = toRecord('comment', row as never);
    const proof = await verifier.proveVersion('comment', record);
    expect(proof).toMatchObject({
      anchored: true,
      purged: 'suggester',
      checks: {
        hash: { outcome: 'cannot-measure', detail: PURGED_SUGGESTER_CHECK },
      },
    });
    const receipt = buildReceipt(
      { type: 'comment', page: 'open-page', commentId },
      [{ kind: 'comment', record, proof }],
      { userId: U.named, isAdmin: false },
    );
    expect(receipt.versions[0].disclosure).toBe('hashes');
    expect(receipt.versions[0].purged).toContain('suggested this wording');
    expect(receipt.notice).toEqual(PURGED_RECEIPT_NOTICE);
    expect(h.comments.docs.length).toBeGreaterThan(0);
    // Round 2, #9d: purged AND withheld versions in one receipt: both said.
    const mixed = buildReceipt(
      { type: 'comment', page: 'open-page', commentId },
      [
        { kind: 'comment', record, proof },
        {
          kind: 'comment',
          record,
          proof: { anchored: false },
          disclose: 'none',
        },
      ],
      { userId: U.named, isAdmin: false },
    );
    expect(mixed.notice[0]).toBe(PURGED_RECEIPT_NOTICE[0]);
    expect(mixed.notice[1]).toBe(PURGED_AND_WITHHELD_LINE);
    // Before its redaction record is anchored: cannot measure, pending.
    const pending = await verifierFor(m, tsa, {
      classify: () => Promise.resolve('suggester-pending'),
    } as never).proveVersion('comment', record);
    expect(pending).toMatchObject({
      purged: 'suggester-pending',
      checks: {
        hash: {
          outcome: 'cannot-measure',
          detail: PURGED_SUGGESTER_PENDING_CHECK,
        },
      },
    });
  });

  it('gives a purged version a cannot-measure receipt, never its hash input (review #3)', async () => {
    const { h, receipts, commentId } = await purgedComment(true);
    // The author's own reading would be "full"; a purged row caps it.
    for (const viewer of [await h.viewer(U.named), await h.viewer(U.admin)]) {
      const receipt = await receipts.comment('open-page', commentId, viewer);
      expect(receipt.notice).toEqual(PURGED_RECEIPT_NOTICE);
      expect(receipt.versions[0]).toMatchObject({
        disclosure: 'hashes',
        hashInput: { included: false, reason: PURGED_HASH_REASON },
      });
      expect(receipt.versions[0].purged).toContain(
        'removed after the retention period',
      );
    }
    // A guest reading the other member's thread: no hashes at all.
    const guest = await receipts.comment(
      'open-page',
      commentId,
      await h.viewer(),
    );
    // The chain holds no person any more, so there is no one to unmask:
    // the hashes tier, never the hash input, and no id anywhere.
    expect(guest.versions[0]).toMatchObject({
      disclosure: 'hashes',
      hashInput: { included: false, reason: PURGED_HASH_REASON },
    });
    expect(JSON.stringify(guest)).not.toContain(U.named);
    expect(guest.notice).toEqual(PURGED_RECEIPT_NOTICE);
  });

  it('says a purged version cannot be re-hashed, never pass and never fail (Chunk 17)', async () => {
    const { h, m, receipts, commentId, row, marks } = await purgedComment(true);
    const receipt = await receipts.comment(
      'open-page',
      commentId,
      await h.viewer(),
    );
    const checks = (
      receipt.versions[0].anchor as {
        serverChecks: Record<string, { outcome: string }>;
      }
    ).serverChecks;
    expect(checks.hash.outcome).toBe('cannot-measure');
    expect(checks.path.outcome).toBe('pass');
    const health = await verifierFor(m, tsa, marks).verifyAll(
      new Date(Date.now() + 20 * 60_000),
    );
    expect(health.anchors[0].versions.outcome).toBe('cannot-measure');
    expect(health.anchors[0].versions.detail).toContain(
      '1 had their personal content removed',
    );
    // A purged row whose stored hash was ALSO changed still fails.
    row.hash = 'e'.repeat(64);
    const changed = await receipts.comment(
      'open-page',
      commentId,
      await h.viewer(),
    );
    expect(
      (
        changed.versions[0].anchor as {
          serverChecks: Record<string, { outcome: string }>;
        }
      ).serverChecks.hash.outcome,
    ).toBe('fail');
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

describe('receipts: one purge-mark check per request (Chunk 17 round 7, 7)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('begins one check for each receipt, however many versions it proves', async () => {
    const { h, receipts, marks } = setUp();
    const begin = jest.spyOn(marks, 'beginCheck');
    await receipts.belief('imported-page', 'tab_i', await h.viewer());
    expect(begin).toHaveBeenCalledTimes(1);
    const { commentId } = await h.commentsService.create(
      await h.writer(U.anon),
      { slug: 'open-page', tabId: 'tab_a', body: 'A synthetic comment.' },
    );
    await receipts.comment('open-page', commentId, await h.viewer());
    expect(begin).toHaveBeenCalledTimes(2);
    const row = h.commentVersions.docs.find(
      (doc) => doc.commentId === commentId,
    ) as never;
    await receipts.exportVersion(
      'comment',
      row,
      { type: 'comment', page: 'open-page', commentId },
      { kind: 'signed-in', userId: U.anon, isAdmin: false },
    );
    expect(begin).toHaveBeenCalledTimes(3);
    const org = await h.commentsService.createOnOrgPage(
      await h.writer(U.named),
      { pageId: 'about', body: 'A synthetic comment on an ORG page.' },
    );
    await receipts.orgComment('about', org.commentId, await h.viewer());
    expect(begin).toHaveBeenCalledTimes(4);
  });
});
