// Chunk 16 review round 3, MEDIUM-1 and L-3: hash material for a version is
// given only when every person on its whole chain may be known to the
// reader. Each test written to fail on the code before the fix.
import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { fakeModel } from '../../test-support/fake-model.mocks-spec';
import {
  type AnchorModels,
  offlineAnchoring,
  verifierFor,
  withAnchorQueries,
} from '../../anchoring/anchoring-harness.mocks-spec';
import { makeTestTsa } from '../../anchoring/test-tsa.mocks-spec';
import { computeVersionHash, GENESIS_HASH } from '../../social/version-chain';
import { CommentAuthorsService } from '../comments/comment-authors.service';
import { harness, ids, U } from '../comments/comments-harness.mocks-spec';
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
  const anchor = () =>
    offlineAnchoring(m, tsa).run(new Date(Date.now() + 10 * 60_000));
  return { h, receipts, anchor };
}

/** Owner accepts a rewording from `suggester`, then edits again. */
async function suggestedThenEdited(
  h: ReturnType<typeof harness>,
  suggester: string,
) {
  const { commentId } = await h.suggestions.suggest(await h.writer(suggester), {
    slug: 'open-page',
    tabId: 'tab_a',
    text: 'A synthetic suggested wording.',
    baseSeq: 1,
  });
  await h.suggestions.accept(U.owner, commentId);
  await h.editor.editTabText(U.owner, 'tab_a', 'The owner edited again.', 2);
}

afterEach(() => jest.restoreAllMocks());

const material = (version: Record<string, unknown>) => ({
  versionHash: version.versionHash,
  prevHash: version.prevHash,
  salt: version.salt,
  included: (version.hashInput as { included: boolean }).included,
});

describe('MEDIUM-1: a chain with a hidden person gives no hash material after it', () => {
  it('a nickname member’s accepted suggestion, then an owner edit: the owner gets nothing to test a guess with', async () => {
    const { h, receipts, anchor } = setUp();
    await suggestedThenEdited(h, U.anon);
    await anchor();
    const owner = await h.viewer(U.owner);
    for (const seq of [3, 2]) {
      const receipt = await receipts.belief(
        'open-page',
        'tab_a',
        owner,
        'text',
        seq,
      );
      expect(material(receipt.versions[0] as never)).toEqual({
        versionHash: undefined,
        prevHash: undefined,
        salt: undefined,
        included: false,
      });
    }
    // The version before the suggestion has no hidden person: still complete.
    const first = await receipts.belief('open-page', 'tab_a', owner, 'text', 1);
    expect(first.versions[0].hashInput.included).toBe(true);
    // History: no prefix on the suggested version or anything after it.
    const history = await h.history.tabHistory('open-page', 'tab_a', owner);
    expect(history.entries.map((e) => [e.seq, e.hash !== undefined])).toEqual([
      [3, false],
      [2, false],
      [1, true],
    ]);
    // An admin may know everyone: everything.
    const admin = await receipts.belief(
      'open-page',
      'tab_a',
      await h.viewer(U.admin),
    );
    expect(admin.versions[0].hashInput.included).toBe(true);
  });

  it('the same with a suggester the owner may know: the owner gets it all', async () => {
    const { h, receipts, anchor } = setUp();
    await suggestedThenEdited(h, U.named);
    await anchor();
    const owner = await h.viewer(U.owner);
    const receipt = await receipts.belief('open-page', 'tab_a', owner);
    expect(receipt.versions[0].seq).toBe(3);
    expect(receipt.versions[0].hashInput.included).toBe(true);
    expect(receipt.versions[0].prevHash).toBeDefined();
    const history = await h.history.tabHistory('open-page', 'tab_a', owner);
    expect(history.entries.every((e) => e.hash !== undefined)).toBe(true);
  });
});

describe('L-3: text first saved as several paragraphs checks the suggester too', () => {
  it('a paragraph whose first version names a hidden suggester gives no prefixes', async () => {
    const { h } = setUp();
    await h.blocks.create({
      profileId: ids.open,
      blockId: 'blk_a2',
      section: 'beliefs',
      kind: 'paragraph',
      tabId: 'tab_a',
      order: 1,
      currentVersionSeq: 1,
    });
    const fields = {
      blockId: 'blk_a2',
      seq: 1,
      text: 'A second synthetic paragraph.',
      authorUserId: U.owner,
      createdAt: new Date(),
      prevHash: GENESIS_HASH,
      suggestionId: 'cmt_x',
      suggestedBy: U.anon,
    };
    h.versions.docs.push({
      _id: new Types.ObjectId(),
      ...fields,
      hash: computeVersionHash(fields),
    });
    const [entry] = (
      await h.history.tabHistory('open-page', 'tab_a', await h.viewer(U.owner))
    ).entries;
    expect(entry.partHashes).toBeUndefined();
    expect(entry.hash).toBeUndefined();
  });
});

describe('MEDIUM-1: comment history follows its whole chain too', () => {
  it('a hidden person anywhere on a comment’s chain hides the prefixes', async () => {
    const { h } = setUp();
    const { commentId } = await h.commentsService.create(
      await h.writer(U.named),
      { slug: 'open-page', tabId: 'tab_a', body: 'A synthetic comment.' },
    );
    const before = await h.commentsService.history(
      'open-page',
      commentId,
      await h.viewer(),
    );
    expect(before.entries[0].hash).toBeDefined();
    // A version by someone else on the same chain (no route writes one
    // today; the rule must not depend on that).
    const first = h.commentVersions.docs[0] as Record<string, any>;
    h.commentVersions.docs.push({
      ...first,
      _id: new Types.ObjectId(),
      seq: 2,
      authorUserId: U.anon,
    });
    const after = await h.commentsService.history(
      'open-page',
      commentId,
      await h.viewer(),
    );
    expect(after.entries.every((e) => e.hash === undefined)).toBe(true);
  });
});
