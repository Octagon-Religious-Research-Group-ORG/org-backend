/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- fake rows */
// Review round 2, M-A: nothing a reader receives may let them confirm a
// guessed author id offline, unless they may know who the author is.
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { fakeModel } from '../../test-support/fake-model.mocks-spec';
import {
  type AnchorModels,
  offlineAnchoring,
  verifierFor,
  withAnchorQueries,
} from '../../anchoring/anchoring-harness.mocks-spec';
import { leafHash, rootFromPath } from '../../anchoring/merkle';
import { makeTestTsa } from '../../anchoring/test-tsa.mocks-spec';
import { computeVersionHash, GENESIS_HASH } from '../../social/version-chain';
import { CommentAuthorsService } from '../comments/comment-authors.service';
import { harness, ids, U } from '../comments/comments-harness.mocks-spec';
import { unzipSync } from 'fflate';
import { receiptZip } from '../../anchoring/receipt';
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
  return { h, m, receipts, anchor };
}

/** A belief on the anonymous member's page (the harness seeds none). */
async function anonymousBelief(h: ReturnType<typeof harness>) {
  await h.tabs.create({
    profileId: ids.anon,
    tabId: 'tab_anon',
    title: 'Synthetic',
    order: 0,
    reviewStatus: 'confirmed',
  });
  await h.blocks.create({
    profileId: ids.anon,
    blockId: 'blk_anon',
    section: 'beliefs',
    kind: 'paragraph',
    tabId: 'tab_anon',
    order: 0,
    currentVersionSeq: 1,
  });
  const fields = {
    blockId: 'blk_anon',
    seq: 1,
    text: 'A synthetic anonymous belief.',
    authorUserId: U.anon,
    createdAt: new Date(),
    prevHash: GENESIS_HASH,
  };
  const version = {
    _id: new Types.ObjectId(),
    ...fields,
    hash: computeVersionHash(fields),
  };
  h.versions.docs.push(version);
  return version;
}

const sha = (hex: string) =>
  createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');

afterEach(() => jest.restoreAllMocks());

describe('receipts: no hash material for a reader who may not know the author', () => {
  it('an anonymous member’s comment: a member reader gets the leaf and proofs, nothing to test a guess with', async () => {
    const { h, receipts, anchor } = setUp();
    const { commentId } = await h.commentsService.create(
      await h.writer(U.anon),
      {
        slug: 'open-page',
        tabId: 'tab_a',
        body: 'A synthetic comment.',
      },
    );
    await anchor();
    const stored = h.commentVersions.docs[0] as Record<string, any>;
    for (const reader of [undefined, U.named, U.owner]) {
      const receipt = await receipts.comment(
        'open-page',
        commentId,
        await h.viewer(reader),
      );
      const text = JSON.stringify(receipt);
      expect(text).not.toContain(stored.hash);
      expect(text).not.toContain(stored.hash.slice(0, 12));
      const [version] = receipt.versions;
      expect(version.versionHash).toBeUndefined();
      expect(version.prevHash).toBeUndefined();
      expect(version.salt).toBeUndefined();
      expect(
        version.anchor.state === 'anchored' &&
          rootFromPath(version.anchor.leaf, version.anchor.path),
      ).toBe(version.anchor.state === 'anchored' && version.anchor.root);
    }
    const own = (
      await receipts.comment('open-page', commentId, await h.viewer(U.anon))
    ).versions[0];
    expect(own.versionHash).toBe(stored.hash);
    expect(own.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(own.anchor.state === 'anchored' && own.anchor.leaf).toBe(
      sha(`00${stored.hash}${own.salt}`),
    );
    expect(own.anchor.state === 'anchored' && own.anchor.leaf).toBe(
      leafHash(stored.hash, own.salt as string),
    );
  });

  it('a named public author: a guest gets the hash and salt, never the Clerk id (JSON or zip)', async () => {
    const { h, receipts, anchor } = setUp();
    const { commentId } = await h.commentsService.create(
      await h.writer(U.named),
      {
        slug: 'open-page',
        tabId: 'tab_a',
        body: 'A synthetic named comment.',
      },
    );
    await anchor();
    const receipt = await receipts.comment(
      'open-page',
      commentId,
      await h.viewer(),
    );
    const [version] = receipt.versions;
    const stored = h.commentVersions.docs[0] as Record<string, any>;
    expect(version.versionHash).toBe(stored.hash);
    expect(version.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(version.hashInput.included).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain(U.named);
    const files = unzipSync(receiptZip(receipt));
    expect(files['version-1/hash-input.json']).toBeUndefined();
    for (const bytes of Object.values(files)) {
      expect(Buffer.from(bytes).toString('utf8')).not.toContain(U.named);
    }
    expect(receipt.notice.join(' ')).toContain(
      'needs the author’s complete receipt',
    );
    // The author, and an admin, get the full hash input.
    for (const reader of [U.named, U.admin]) {
      const full = await receipts.comment(
        'open-page',
        commentId,
        await h.viewer(reader),
      );
      expect(full.versions[0].hashInput.included).toBe(true);
    }
  });

  it('an anonymous member’s belief: other readers get no hash material', async () => {
    const { h, receipts, anchor } = setUp();
    const v = await anonymousBelief(h);
    await anchor();
    const forMember = await receipts.belief(
      'anon-writer',
      'tab_anon',
      await h.viewer(U.named),
    );
    expect(JSON.stringify(forMember)).not.toContain(v.hash);
    expect(forMember.versions[0].prevHash).toBeUndefined();
  });
});

describe('history (Chunks 8/9): no hash prefix for a reader who may not know the author', () => {
  it('comment history', async () => {
    const { h } = setUp();
    const { commentId } = await h.commentsService.create(
      await h.writer(U.anon),
      {
        slug: 'open-page',
        tabId: 'tab_a',
        body: 'A synthetic comment.',
      },
    );
    const forOwner = await h.commentsService.history(
      'open-page',
      commentId,
      await h.viewer(U.owner),
    );
    expect(forOwner.entries[0].hash).toBeUndefined();
    const forAuthor = await h.commentsService.history(
      'open-page',
      commentId,
      await h.viewer(U.anon),
    );
    expect(forAuthor.entries[0].hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('belief history', async () => {
    const { h } = setUp();
    await anonymousBelief(h);
    const forMember = await h.history.tabHistory(
      'anon-writer',
      'tab_anon',
      await h.viewer(U.named),
    );
    expect(forMember.entries[0].hash).toBeUndefined();
    const forOwner = await h.history.tabHistory(
      'anon-writer',
      'tab_anon',
      await h.viewer(U.anon),
    );
    expect(forOwner.entries[0].hash).toMatch(/^[0-9a-f]{12}$/);
    // Imported text names no one: its prefix stays for everyone.
    const imported = await h.history.tabHistory(
      'open-page',
      'tab_a',
      await h.viewer(),
    );
    expect(imported.entries[0].hash).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('round 2: the remaining edges', () => {
  it('an anonymous member’s text first saved as several paragraphs: no prefixes', async () => {
    const { h } = setUp();
    await anonymousBelief(h);
    await h.blocks.create({
      profileId: ids.anon,
      blockId: 'blk_anon2',
      section: 'beliefs',
      kind: 'paragraph',
      tabId: 'tab_anon',
      order: 1,
      currentVersionSeq: 1,
    });
    const fields = {
      blockId: 'blk_anon2',
      seq: 1,
      text: 'A second synthetic paragraph.',
      authorUserId: U.anon,
      createdAt: new Date(),
      prevHash: GENESIS_HASH,
    };
    h.versions.docs.push({
      _id: new Types.ObjectId(),
      ...fields,
      hash: computeVersionHash(fields),
    });
    const [entry] = (
      await h.history.tabHistory(
        'anon-writer',
        'tab_anon',
        await h.viewer(U.named),
      )
    ).entries;
    expect(entry.hash).toBeUndefined();
    expect(entry.partHashes).toBeUndefined();
    const [own] = (
      await h.history.tabHistory(
        'anon-writer',
        'tab_anon',
        await h.viewer(U.anon),
      )
    ).entries;
    expect(own.partHashes).toHaveLength(2);
  });

  it('a page row with no review status reads as approved', async () => {
    const { h } = setUp();
    await h.profiles
      .updateOne({ slug: 'named-writer' }, { $unset: { reviewStatus: 1 } })
      .exec();
    const known = await new CommentAuthorsService(
      h.profiles as never,
    ).identifiable([U.named, undefined, 'system:import'], await h.viewer());
    expect([
      known(U.named),
      known(undefined),
      known('system:import'),
      known('user_nobody'),
    ]).toEqual([true, true, true, false]);
  });
});
