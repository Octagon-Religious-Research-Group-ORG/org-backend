/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- real Mongo rows */
// Timestamp anchoring (Chunk 16) against a REAL MongoDB: the indexes, both
// version kinds in one batch, idempotency and racing instances (no version
// lost, none anchored twice), the nothing-new no-op, one provider down, the
// OpenTimestamps upgrade, tamper detection on real rows, and who may have a
// receipt. Needs MONGO_TEST_URI (a throwaway replica-set database; it is
// dropped); the build race also runs on MONGO_STANDALONE_URI when given,
// since anchoring needs no transaction. Without them the suites are SKIPPED,
// never passed.
//
// No request leaves the machine: FreeTSA is the synthetic TSA (same token
// shape as the real one), the calendars answer with the REAL Step 0 answers
// replayed for each root. Synthetic data only.
import { Logger, NotFoundException } from '@nestjs/common';
import mongoose, { type Model, Types } from 'mongoose';
import { AnchorVerifierService } from '../src/anchoring/anchor-verifier.service';
import { asBytes } from '../src/anchoring/bytes';
import {
  AnchoringService,
  anchorDay,
} from '../src/anchoring/anchoring.service';
import { parseDetached, parseTimestamp, summarize } from '../src/anchoring/ots';
import { CALENDAR_RESPONSES } from '../src/anchoring/step0-fixtures.mocks-spec';
import {
  makeTestTsa,
  type TestTsa,
} from '../src/anchoring/test-tsa.mocks-spec';
import { WebsitePageSchema } from '../src/content/schemas/website-page.schema';
import { MANAGED_SCHEMAS } from '../src/db/managed-schemas';
import { CommentAuthorsService } from '../src/members/comments/comment-authors.service';
import { CommentStore } from '../src/members/comments/comment-store';
import {
  type CommentWriter,
  CommentWritersService,
} from '../src/members/comments/comment-writers';
import {
  seedBlocks,
  seedOrgPages,
  seedProfiles,
  seedTabs,
  U,
} from '../src/members/comments/comments-harness.mocks-spec';
import { CommentsService } from '../src/members/comments/comments.service';
import { MemberHistoryService } from '../src/members/member-history.service';
import { MemberPageEditorService } from '../src/members/member-page-editor.service';
import { MembersService } from '../src/members/members.service';
import { OrgPagesService } from '../src/members/org-pages/org-pages.service';
import { ReceiptsService } from '../src/members/receipts/receipts.service';
import { SuggestionsService } from '../src/members/comments/suggestions.service';
import { VoteTalliesService } from '../src/members/votes/vote-tallies.service';
import { BlockVersionsService } from '../src/social/block-versions.service';
import { CommentVersionsService } from '../src/social/comment-versions.service';
import {
  COMMENT_HASH_SCHEME,
  computeVersionHash,
  GENESIS_HASH,
} from '../src/social/version-chain';

const replicaUri = process.env.MONGO_TEST_URI;
const standaloneUri = process.env.MONGO_STANDALONE_URI;
const describeWithMongo = replicaUri ? describe : describe.skip;

const request = (userId?: string) =>
  ({
    headers: userId ? { authorization: `Bearer ${userId}` } : {},
    ...(userId ? { auth: { payload: { sub: userId } } } : {}),
  }) as never;

/** A bitcoin attestation subtree (synthetic height) for a commitment. */
function bitcoinTree(commitment: string) {
  return parseTimestamp(
    Buffer.from('08000588960d73d7190103eb8d35', 'hex'),
    Buffer.from(commitment, 'hex'),
  );
}

interface Providers {
  tsaDown: boolean;
  calendarsDown: boolean;
  upgrade: jest.Mock;
  tsaCalls: string[];
  otsCalls: string[];
}

function anchoringOn(
  m: Record<string, Model<any>>,
  tsa: TestTsa,
  p: Providers,
) {
  const settings = { enabled: true, hourUtc: 0 };
  const service = new AnchoringService(
    m.TimestampAnchor,
    m.AnchorLeaf,
    m.BlockVersion,
    m.CommentVersion,
    {
      settings,
      timestamp: async (root: string) => {
        p.tsaCalls.push(root);
        // Slow enough for two instances to overlap.
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (p.tsaDown) throw new Error('HTTP 503 (synthetic outage)');
        return {
          response: tsa.respond(root),
          tst: { genTime: new Date(), serial: '0a01e815' },
        };
      },
    } as never,
    {
      settings,
      submit: (root: string) => {
        p.otsCalls.push(root);
        return Promise.resolve(
          Object.entries(CALENDAR_RESPONSES).map(([url, body]) =>
            p.calendarsDown
              ? { url, ok: false, error: 'HTTP 503' }
              : {
                  url,
                  ok: true,
                  tree: parseTimestamp(body, Buffer.from(root, 'hex')),
                },
          ),
        );
      },
      upgrade: p.upgrade,
    } as never,
  );
  service.retryPauseMs = 0;
  return service;
}

async function connect(uri: string) {
  const conn = await mongoose.createConnection(uri).asPromise();
  await conn.dropDatabase();
  const m = {} as Record<string, Model<any>>;
  for (const { name, schema } of MANAGED_SCHEMAS) {
    m[name] = conn.model(name, schema);
    await m[name].createCollection();
    await m[name].createIndexes();
  }
  return { conn, m };
}

let counter = 0;
async function blockVersion(
  m: Record<string, Model<any>>,
  createdAt = new Date(),
) {
  counter += 1;
  const fields = {
    blockId: `blk_e2e_${counter}`,
    seq: 1,
    text: `Synthetic belief ${counter}.`,
    authorUserId: 'user_owner',
    createdAt,
    prevHash: GENESIS_HASH,
  };
  const doc = {
    _id: new Types.ObjectId(),
    ...fields,
    hash: computeVersionHash(fields),
  };
  await m.BlockVersion.collection.insertOne(doc);
  return doc;
}
async function commentVersion(
  m: Record<string, Model<any>>,
  createdAt = new Date(),
) {
  counter += 1;
  const fields = {
    commentId: `cmt_e2e_${counter}`,
    seq: 1,
    text: `Synthetic comment ${counter}.`,
    authorUserId: 'user_writer',
    createdAt,
    prevHash: GENESIS_HASH,
  };
  const doc = {
    _id: new Types.ObjectId(),
    ...fields,
    hash: computeVersionHash(
      { ...fields, blockId: fields.commentId },
      COMMENT_HASH_SCHEME,
    ),
  };
  await m.CommentVersion.collection.insertOne(doc);
  return doc;
}

const soon = () => new Date(Date.now() + 10 * 60_000);
const fresh = (): Providers => ({
  tsaDown: false,
  calendarsDown: false,
  upgrade: jest.fn().mockResolvedValue({ state: 'pending' }),
  tsaCalls: [],
  otsCalls: [],
});

describeWithMongo('timestamp anchoring on a real MongoDB', () => {
  jest.setTimeout(120_000);
  const tsa = makeTestTsa();
  let conn: mongoose.Connection;
  let m: Record<string, Model<any>>;
  let verifier: AnchorVerifierService;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    ({ conn, m } = await connect(String(replicaUri)));
    verifier = new AnchorVerifierService(
      m.TimestampAnchor,
      m.AnchorLeaf,
      m.BlockVersion,
      m.CommentVersion,
    );
    verifier.trustedRoots = [tsa.root];
  });

  beforeEach(async () => {
    for (const name of [
      'TimestampAnchor',
      'AnchorLeaf',
      'BlockVersion',
      'CommentVersion',
    ]) {
      await m[name].collection.deleteMany({});
    }
  });

  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it('creates the declared indexes, and the "is it claimed" lookup uses one', async () => {
    const leaves = await m.AnchorLeaf.collection.indexes();
    expect(leaves.map((i) => Object.keys(i.key).join(','))).toEqual(
      expect.arrayContaining(['_id', 'anchorId', 'versionId']),
    );
    const anchors = await m.TimestampAnchor.collection.indexes();
    expect(anchors.map((i) => Object.keys(i.key).join(','))).toEqual(
      expect.arrayContaining(['_id', 'tsa.status', 'ots.status']),
    );
    const plan = await m.AnchorLeaf.collection
      .find({ versionId: new Types.ObjectId() })
      .explain('queryPlanner');
    expect(JSON.stringify(plan)).toContain('IXSCAN');
  });

  it('nothing new: no anchor row, no request to either provider', async () => {
    const p = fresh();
    expect((await anchoringOn(m, tsa, p).run(soon())).build).toEqual({
      state: 'nothing-new',
    });
    expect(await m.TimestampAnchor.countDocuments()).toBe(0);
    expect([p.tsaCalls, p.otsCalls]).toEqual([[], []]);
  });

  it('batches belief and comment versions together, gets both proofs, and verifies', async () => {
    const b = [await blockVersion(m), await blockVersion(m)];
    const c = [await commentVersion(m)];
    const p = fresh();
    const when = soon();
    const report = await anchoringOn(m, tsa, p).run(when);
    expect(report.build).toEqual({
      state: 'built',
      anchorId: anchorDay(when),
      leaves: 3,
    });
    expect(report.tsa[0].outcome).toBe('granted');
    expect(report.ots[0].outcome).toBe('pending');
    const row = await m.TimestampAnchor.findById(anchorDay(when)).lean();
    expect(row.leaves.map((l: any) => String(l.versionId)).sort()).toEqual(
      [...b, ...c].map((v) => String(v._id)).sort(),
    );
    // Stored as real BSON binary and read back intact.
    expect(parseDetached(asBytes(row.ots.proof)!).digest.toString('hex')).toBe(
      row.merkleRoot,
    );
    expect(p.tsaCalls).toEqual([row.merkleRoot]);
    const health = await verifier.verifyAll();
    expect(health.anchors[0]).toMatchObject({
      root: { outcome: 'pass' },
      versions: { outcome: 'pass' },
      tsa: { outcome: 'pass' },
      ots: { outcome: 'pass' },
      bitcoin: { outcome: 'cannot-measure' },
    });
    expect(health.coverage.outcome).toBe('pass');
    // Idempotent: the same day again changes nothing and asks no one.
    const again = await anchoringOn(m, tsa, p).run(soon());
    expect(again.build.state).toBe('already-built');
    expect(await m.AnchorLeaf.countDocuments()).toBe(3);
    expect(p.tsaCalls).toHaveLength(1);
  });

  it('two instances at once: one anchor, every version claimed exactly once', async () => {
    for (let i = 0; i < 30; i++) await blockVersion(m);
    for (let i = 0; i < 20; i++) await commentVersion(m);
    const p = fresh();
    const when = soon();
    const reports = await Promise.all([
      anchoringOn(m, tsa, p).run(when),
      anchoringOn(m, tsa, p).run(when),
      anchoringOn(m, tsa, p).run(when),
    ]);
    expect(reports.filter((r) => r.build.state === 'built')).toHaveLength(1);
    expect(await m.TimestampAnchor.countDocuments()).toBe(1);
    expect(await m.AnchorLeaf.countDocuments()).toBe(50);
    const row = await m.TimestampAnchor.findById(anchorDay(when)).lean();
    expect(row.leaves).toHaveLength(50);
    // One request per provider, whoever ran.
    expect(p.tsaCalls).toHaveLength(1);
    expect(p.otsCalls).toHaveLength(1);
  });

  it('two instances straddling midnight split the versions: none lost, none twice', async () => {
    for (let i = 0; i < 40; i++) await blockVersion(m);
    const late = new Date(Date.now() + 10 * 60_000);
    const nextDay = new Date(late.getTime() + 24 * 3_600_000);
    const p = fresh();
    const [a, b] = await Promise.all([
      anchoringOn(m, tsa, p).build(late, true),
      anchoringOn(m, tsa, p).build(nextDay, true),
    ]);
    const counted = [a, b].reduce(
      (sum, r) => sum + (r.state === 'built' ? r.leaves : 0),
      0,
    );
    expect(counted).toBe(40);
    const claims = await m.AnchorLeaf.find({}).lean();
    expect(new Set(claims.map((c: any) => String(c.versionId))).size).toBe(40);
    expect(claims).toHaveLength(40);
  });

  it('round 4, LOW-1: a claim that lands after the recount is released and anchored the next day', async () => {
    const today = soon();
    await blockVersion(m, new Date(today.getTime() - 3 * 3_600_000));
    const late = await blockVersion(
      m,
      new Date(today.getTime() - 2 * 3_600_000),
    );
    const anchors = m.TimestampAnchor;
    const original = anchors.updateOne.bind(anchors);
    let injected = false;
    const spy = jest.spyOn(anchors, 'updateOne').mockImplementation(((
      filter: object,
      change: any,
    ) => {
      const query = original(filter, change);
      if (!injected && change?.$set?.status === 'built') {
        injected = true;
        const exec = query.exec.bind(query);
        // A builder whose lease ran out claims `late` right now.
        query.exec = async () => {
          await m.AnchorLeaf.create({
            _id: `b:${String(late._id)}`,
            anchorId: anchorDay(today),
            kind: 'block',
            versionId: late._id,
            versionHash: late.hash,
            versionCreatedAt: late.createdAt,
            salt: 'a'.repeat(64),
            leaseId: 'a-builder-that-lost-its-lease',
          });
          return exec();
        };
      }
      return query;
    }) as never);
    const service = anchoringOn(m, tsa, fresh());
    service.maxLeaves = 1;
    const report = await service.run(today);
    spy.mockRestore();
    expect(injected).toBe(true);
    expect(report.build).toMatchObject({ state: 'built', leaves: 1 });
    expect(
      await m.AnchorLeaf.findById(`b:${String(late._id)}`).lean(),
    ).toBeNull();
    const tomorrow = new Date(today.getTime() + 24 * 3_600_000);
    expect(
      (await anchoringOn(m, tsa, fresh()).run(tomorrow)).build,
    ).toMatchObject({ state: 'built', leaves: 1 });
    const claim = await m.AnchorLeaf.findById(`b:${String(late._id)}`).lean();
    expect(claim.anchorId).toBe(anchorDay(tomorrow));
    const anchor = await m.TimestampAnchor.findById(anchorDay(tomorrow)).lean();
    expect(
      anchor.leaves.map((leaf: { versionId: unknown }) =>
        String(leaf.versionId),
      ),
    ).toEqual([String(late._id)]);
  });

  it('round 4 sweep: a builder that crashed after its insert leaves a claim; a later run releases it and anchors the version', async () => {
    const start = soon();
    const days = [0, 1, 2].map(
      (n) => new Date(start.getTime() + n * 24 * 3_600_000),
    );
    for (const at of days) {
      await blockVersion(m, new Date(at.getTime() - 3_600_000));
      await anchoringOn(m, tsa, fresh()).run(at);
    }
    const late = await blockVersion(
      m,
      new Date(days[0].getTime() - 3 * 3_600_000),
    );
    // What the crashed builder left in the first day's anchor.
    await m.AnchorLeaf.create({
      _id: 'b:' + String(late._id),
      anchorId: anchorDay(days[0]),
      kind: 'block',
      versionId: late._id,
      versionHash: late.hash,
      versionCreatedAt: late.createdAt,
      salt: 'c'.repeat(64),
      leaseId: 'a-builder-that-crashed',
    });
    const later = new Date(start.getTime() + 5 * 24 * 3_600_000);
    await blockVersion(m, new Date(later.getTime() - 3_600_000));
    const report = await anchoringOn(m, tsa, fresh()).run(later);
    expect(report.released).toEqual([anchorDay(days[0])]);
    expect(report.build).toMatchObject({ state: 'built', leaves: 2 });
    const claim = await m.AnchorLeaf.findById('b:' + String(late._id)).lean();
    expect(claim.anchorId).toBe(anchorDay(later));
    const first = await m.TimestampAnchor.findById(anchorDay(days[0])).lean();
    expect(first.rescanFrom).toBeUndefined();
    expect(first.leafCount).toBe(
      await m.AnchorLeaf.countDocuments({ anchorId: anchorDay(days[0]) }),
    );
  });

  it('a version anchored the next day is never in today’s batch', async () => {
    await blockVersion(m);
    const p = fresh();
    const today = soon();
    await anchoringOn(m, tsa, p).run(today);
    const later = await commentVersion(m, new Date(today.getTime() + 60_000));
    const tomorrow = new Date(today.getTime() + 24 * 3_600_000);
    const report = await anchoringOn(m, tsa, p).run(tomorrow);
    expect(report.build).toMatchObject({ state: 'built', leaves: 1 });
    const claim = await m.AnchorLeaf.findById(`c:${String(later._id)}`).lean();
    expect(claim.anchorId).toBe(anchorDay(tomorrow));
  });

  it('FreeTSA down: OpenTimestamps still proceeds; FreeTSA is retried after its back-off', async () => {
    await blockVersion(m);
    const p = fresh();
    p.tsaDown = true;
    const when = soon();
    const first = await anchoringOn(m, tsa, p).run(when);
    expect(first.tsa[0].outcome).toBe('failed');
    expect(first.ots[0].outcome).toBe('pending');
    let row = await m.TimestampAnchor.findById(anchorDay(when)).lean();
    expect(row.tsa).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row.tsa.lastError).toContain('synthetic outage');
    expect((await verifier.verifyAll()).anchors[0].tsa.outcome).toBe(
      'cannot-measure',
    );
    p.tsaDown = false;
    const retry = await anchoringOn(m, tsa, p).run(
      new Date(when.getTime() + 3_600_000),
    );
    expect(retry.tsa[0].outcome).toBe('granted');
    row = await m.TimestampAnchor.findById(anchorDay(when)).lean();
    expect(row.tsa).toMatchObject({
      status: 'granted',
      attempts: 2,
      lastError: null,
    });
  });

  it('calendars down: FreeTSA still proceeds; OpenTimestamps is retried', async () => {
    await blockVersion(m);
    const p = fresh();
    p.calendarsDown = true;
    const when = soon();
    const first = await anchoringOn(m, tsa, p).run(when);
    expect([first.tsa[0].outcome, first.ots[0].outcome]).toEqual([
      'granted',
      'failed',
    ]);
    p.calendarsDown = false;
    const retry = await anchoringOn(m, tsa, p).run(
      new Date(when.getTime() + 3_600_000),
    );
    expect(retry.ots[0].outcome).toBe('pending');
  });

  it('upgrades a pending proof once Bitcoin has it, then stops asking', async () => {
    await blockVersion(m);
    const p = fresh();
    const when = soon();
    await anchoringOn(m, tsa, p).run(when);
    p.upgrade.mockImplementation((_uri: string, commitment: string) =>
      Promise.resolve({ state: 'upgraded', tree: bitcoinTree(commitment) }),
    );
    const sixHours = new Date(when.getTime() + 6 * 3_600_000);
    expect((await anchoringOn(m, tsa, p).run(sixHours)).ots[0].outcome).toBe(
      'confirmed',
    );
    const row = await m.TimestampAnchor.findById(anchorDay(when)).lean();
    expect(row.ots).toMatchObject({
      status: 'confirmed',
      bitcoinHeights: [870_123],
    });
    const proof = parseDetached(asBytes(row.ots.proof)!);
    expect(summarize(proof.tree).bitcoin).toHaveLength(1);
    expect((await verifier.verifyAll()).anchors[0].bitcoin.detail).toContain(
      'claims block 870123',
    );
    p.upgrade.mockClear();
    await anchoringOn(m, tsa, p).run(new Date(when.getTime() + 48 * 3_600_000));
    expect(p.upgrade).not.toHaveBeenCalled();
  });

  it('review H1: a build that died after its claims is finished on the next day', async () => {
    const old = [await blockVersion(m), await commentVersion(m)];
    const p = fresh();
    const today = soon();
    const day = anchorDay(today);
    const service = anchoringOn(m, tsa, p);
    // Dies between the claims and the root write.
    const spy = jest
      .spyOn(m.TimestampAnchor, 'updateOne')
      .mockImplementationOnce(() => {
        throw new Error('process killed');
      });
    await expect(service.run(today)).rejects.toThrow('process killed');
    spy.mockRestore();
    expect((await m.TimestampAnchor.findById(day).lean()).status).toBe(
      'building',
    );
    expect(await m.AnchorLeaf.countDocuments({ anchorId: day })).toBe(2);
    // While it is stuck, coverage is no pass.
    const stuckHealth = await verifier.verifyAll(
      new Date(today.getTime() + 3_600_000),
    );
    expect(stuckHealth.coverage.outcome).toBe('fail');
    expect(stuckHealth.coverage.detail).toContain(
      'claimed by unfinished anchor',
    );

    const tomorrow = new Date(today.getTime() + 24 * 3_600_000);
    await blockVersion(m, new Date(today.getTime() + 3_600_000));
    const report = await anchoringOn(m, tsa, p).run(tomorrow);
    expect(report.resumed).toEqual([
      { state: 'built', anchorId: day, leaves: 2 },
    ]);
    const row = await m.TimestampAnchor.findById(day).lean();
    expect(row.status).toBe('built');
    expect(row.leaves.map((l: any) => String(l.versionId)).sort()).toEqual(
      old.map((v) => String(v._id)).sort(),
    );
    expect(report.build).toMatchObject({
      state: 'built',
      anchorId: anchorDay(tomorrow),
      leaves: 1,
    });
    expect((await verifier.verifyAll(tomorrow)).coverage.outcome).toBe('pass');
  });

  it('review M1: a capped first run over old history anchors every version over the next days', async () => {
    for (let i = 0; i < 7; i++) {
      await blockVersion(m, new Date(Date.UTC(2026, 8, 1 + i)));
    }
    for (let i = 0; i < 3; i++) {
      await commentVersion(m, new Date(Date.UTC(2026, 8, 1 + i, 12)));
    }
    const start = soon();
    for (let day = 0; day < 4; day++) {
      const service = anchoringOn(m, tsa, fresh());
      service.maxLeaves = 3;
      await service.run(new Date(start.getTime() + day * 24 * 3_600_000));
      if (day === 0) {
        // Capped: an open resume point, stored (review round 5).
        const opened = await m.TimestampAnchor.findById(
          anchorDay(start),
        ).lean();
        expect(opened.resumeOpen).toBe(true);
      }
    }
    expect(await m.AnchorLeaf.countDocuments()).toBe(10);
    const first = await m.TimestampAnchor.findById(anchorDay(start)).lean();
    // The oldest three of either kind, merged by time.
    expect(first.leaves.map((l: any) => l.kind).sort()).toEqual([
      'block',
      'block',
      'comment',
    ]);
    expect(first.resumeFrom).toBeInstanceOf(Date);
    // Covered by a later batch: closed, the history kept.
    expect(first.resumeOpen).toBeUndefined();
  });

  describe('tampering with real rows is detected', () => {
    let blocks: Array<{ _id: Types.ObjectId; hash: string }>;
    let anchorId: string;

    beforeEach(async () => {
      blocks = [
        await blockVersion(m),
        await blockVersion(m),
        await blockVersion(m),
      ];
      await commentVersion(m);
      const when = soon();
      await anchoringOn(m, tsa, fresh()).run(when);
      anchorId = anchorDay(when);
      expect(Object.values((await verifier.verifyAll()).totals.root)).toEqual([
        1, 0, 0,
      ]);
    });

    // Raw collection writes: what someone with database access could do,
    // past the append-only hooks.
    it('a version text', async () => {
      await m.BlockVersion.collection.updateOne(
        { _id: blocks[0]._id },
        { $set: { text: 'Rewritten afterwards.' } },
      );
      expect((await verifier.verifyAll()).anchors[0].versions).toMatchObject({
        outcome: 'fail',
        detail: expect.stringContaining('its fields no longer give its hash'),
      });
    });

    it('a version text with its hash recomputed', async () => {
      const row = await m.BlockVersion.findById(blocks[0]._id).lean();
      const text = 'Rewritten, hash and all.';
      await m.BlockVersion.collection.updateOne(
        { _id: blocks[0]._id },
        { $set: { text, hash: computeVersionHash({ ...row, text }) } },
      );
      expect((await verifier.verifyAll()).anchors[0].versions.detail).toContain(
        'stored hash differs from the anchored one',
      );
    });

    it('the root', async () => {
      await m.TimestampAnchor.collection.updateOne(
        { _id: anchorId as never },
        { $set: { merkleRoot: 'f'.repeat(64) } },
      );
      const r = (await verifier.verifyAll()).anchors[0];
      expect([r.root.outcome, r.tsa.outcome, r.ots.outcome]).toEqual([
        'fail',
        'fail',
        'fail',
      ]);
    });

    it('a sibling on a version’s path (the stored leaf list)', async () => {
      const row = await m.TimestampAnchor.findById(anchorId).lean();
      const other = row.leaves.findIndex(
        (l: any) => String(l.versionId) !== String(blocks[0]._id),
      );
      await m.TimestampAnchor.collection.updateOne(
        { _id: anchorId as never },
        { $set: { [`leaves.${other}.leaf`]: 'a'.repeat(64) } },
      );
      const r = (await verifier.verifyAll()).anchors[0];
      expect(r.root.outcome).toBe('fail');
      const record = await m.BlockVersion.findById(blocks[0]._id).lean();
      const proof = await verifier.proveVersion('block', {
        ...record,
        key: record.blockId,
      });
      // Whether the altered leaf is on this version's path or not, the
      // rebuilt root no longer matches what was time-stamped.
      expect(
        proof.anchored && [proof.checks.path.outcome, proof.checks.tsa.outcome],
      ).toEqual(['fail', 'pass']);
    });

    it('the FreeTSA token', async () => {
      await m.TimestampAnchor.collection.updateOne(
        { _id: anchorId as never },
        { $set: { 'tsa.response': tsa.respond('b'.repeat(64)) } },
      );
      expect((await verifier.verifyAll()).anchors[0].tsa).toEqual({
        outcome: 'fail',
        detail: 'imprint does not match',
      });
    });

    it('a deleted version', async () => {
      await m.BlockVersion.collection.deleteOne({ _id: blocks[1]._id });
      expect((await verifier.verifyAll()).anchors[0].versions.detail).toContain(
        'version missing',
      );
    });
  });
});

describe(
  standaloneUri
    ? 'anchoring on a STANDALONE MongoDB'
    : 'anchoring on a standalone MongoDB (SKIPPED: no MONGO_STANDALONE_URI)',
  () => {
    const run = standaloneUri ? it : it.skip;
    run(
      'needs no transaction: racing instances still give one anchor, each version once',
      async () => {
        jest.spyOn(Logger.prototype, 'log').mockImplementation();
        const { conn, m } = await connect(String(standaloneUri));
        try {
          for (let i = 0; i < 25; i++) await blockVersion(m);
          const tsa = makeTestTsa();
          const p = fresh();
          const when = soon();
          const reports = await Promise.all([
            anchoringOn(m, tsa, p).run(when),
            anchoringOn(m, tsa, p).run(when),
          ]);
          expect(reports.filter((r) => r.build.state === 'built')).toHaveLength(
            1,
          );
          expect(await m.AnchorLeaf.countDocuments()).toBe(25);
        } finally {
          await conn.dropDatabase();
          await conn.close();
        }
      },
      60_000,
    );
  },
);

describeWithMongo(
  'receipts on a real MongoDB: the same visibility as reading',
  () => {
    jest.setTimeout(120_000);
    const tsa = makeTestTsa();
    let conn: mongoose.Connection;
    let m: Record<string, Model<any>>;
    let members: MembersService;
    let writers: CommentWritersService;
    let comments: CommentsService;
    let receipts: ReceiptsService;
    let suggestions: SuggestionsService;
    let historyService: MemberHistoryService;
    let editorService: MemberPageEditorService;
    const viewer = (userId?: string) => members.resolveViewer(request(userId));
    const writer = (userId: string): Promise<CommentWriter> =>
      writers.requireWriter(request(userId));
    const gone = new NotFoundException('x').getStatus();

    async function status(work: Promise<unknown>): Promise<number> {
      try {
        await work;
        return 200;
      } catch (error) {
        if (error instanceof NotFoundException) return error.getStatus();
        throw error;
      }
    }

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const db = await connect(
        String(replicaUri).replace(/\/x(\?|$)/, '/x_receipts$1'),
      );
      conn = db.conn;
      m = db.m;
      m.WebsitePage = conn.model('WebsitePage', WebsitePageSchema);
      await m.WebsitePage.collection.insertMany(seedOrgPages());
      const seeded = seedBlocks();
      await m.SocialProfile.collection.insertMany(seedProfiles());
      await m.BeliefTab.collection.insertMany(
        seedTabs().map((t) => ({ ...t, createdAt: new Date() })),
      );
      await m.ProfileBlock.collection.insertMany(seeded.map((s) => s.block));
      await m.BlockVersion.collection.insertMany(seeded.map((s) => s.version));
      const orgPages = new OrgPagesService(m.WebsitePage);
      members = new MembersService(
        m.SocialProfile,
        m.BeliefTab,
        m.ProfileBlock,
        m.BlockVersion,
        m.Comment,
        { currentPicture: () => Promise.resolve(undefined) } as never,
        {} as never,
        {
          isAdminForRead: (req: { auth: { payload: { sub: string } } }) =>
            Promise.resolve(req.auth.payload.sub.startsWith('user_admin')),
        } as never,
      );
      const tallies = new VoteTalliesService(
        m.VoteTally,
        m.BeliefVote,
        m.BeliefTab,
        m.ProfileBlock,
        m.BlockVersion,
        orgPages,
      );
      const editor = new MemberPageEditorService(
        m.SocialProfile,
        m.BeliefTab,
        m.ProfileBlock,
        m.BlockVersion,
        new BlockVersionsService(m.BlockVersion, m.ProfileBlock),
        tallies,
      );
      writers = new CommentWritersService(members, {
        getIdentity: (userId: string) =>
          Promise.resolve({
            email: `${userId}@example.test`,
            emailVerified: true,
          }),
      } as never);
      const authors = new CommentAuthorsService(m.SocialProfile);
      comments = new CommentsService(
        m.BeliefTab,
        new CommentStore(m.Comment),
        members,
        editor,
        new CommentVersionsService(m.CommentVersion),
        authors,
        m.BeliefVote,
        orgPages,
      );
      const history = new MemberHistoryService(
        members,
        m.BeliefTab,
        m.ProfileBlock,
        m.BlockVersion,
        authors,
        m.Comment,
      );
      const verifier = new AnchorVerifierService(
        m.TimestampAnchor,
        m.AnchorLeaf,
        m.BlockVersion,
        m.CommentVersion,
      );
      verifier.trustedRoots = [tsa.root];
      receipts = new ReceiptsService(history, comments, verifier, authors);
      historyService = history;
      editorService = editor;
      suggestions = new SuggestionsService(
        m.Comment,
        m.SocialProfile,
        m.ProfileBlock,
        m.BlockVersion,
        new CommentStore(m.Comment),
        comments,
        editor,
        new CommentVersionsService(m.CommentVersion),
      );
    });

    it('round 3, MEDIUM-1: a nickname member’s accepted suggestion hides the hash material of every later version', async () => {
      const { commentId } = await suggestions.suggest(await writer(U.anon), {
        slug: 'open-page',
        tabId: 'tab_b',
        text: 'A synthetic suggested wording.',
        baseSeq: 1,
      });
      await suggestions.accept(U.owner, commentId);
      await editorService.editTabText(U.owner, 'tab_b', 'Edited again.', 2);
      // Not anchored here: the day's anchor belongs to the next test. The
      // hashes are withheld whatever the anchoring state.
      const owner = await viewer(U.owner);
      for (const seq of [3, 2]) {
        const [version] = (
          await receipts.belief('open-page', 'tab_b', owner, 'text', seq)
        ).versions;
        expect([
          version.versionHash,
          version.prevHash,
          version.salt,
          version.hashInput.included,
        ]).toEqual([undefined, undefined, undefined, false]);
      }
      const history = await historyService.tabHistory(
        'open-page',
        'tab_b',
        owner,
      );
      expect(history.entries.map((e) => [e.seq, e.hash !== undefined])).toEqual(
        [
          [3, false],
          [2, false],
          [1, true],
        ],
      );
      const admin = await receipts.belief(
        'open-page',
        'tab_b',
        await viewer(U.admin),
      );
      expect(admin.versions[0].hashInput.included).toBe(true);
    });

    afterAll(async () => {
      await conn.dropDatabase();
      await conn.close();
    });

    /** guest, member, owner, admin: who gets the belief receipt. */
    async function beliefMatrix(slug: string, tabId: string, owner: string) {
      const result: Record<string, number> = {};
      for (const [name, user] of [
        ['guest', undefined],
        ['member', U.named],
        ['owner', owner],
        ['admin', U.admin],
      ] as const) {
        result[name] = await status(
          receipts.belief(slug, tabId, await viewer(user)),
        );
      }
      return result;
    }

    it('public, members-only, private and pending pages', async () => {
      expect(await beliefMatrix('open-page', 'tab_a', U.owner)).toEqual({
        guest: 200,
        member: 200,
        owner: 200,
        admin: 200,
      });
      expect(
        await beliefMatrix('members-page', 'tab_m', U.membersOwner),
      ).toEqual({
        guest: gone,
        member: 200,
        owner: 200,
        admin: 200,
      });
      expect(await beliefMatrix('hidden-page', 'tab_h', U.hiddenOwner)).toEqual(
        {
          guest: gone,
          member: gone,
          owner: 200,
          admin: 200,
        },
      );
      expect(await beliefMatrix('waiting-page', 'tab_w', U.waiting)).toEqual({
        guest: gone,
        member: gone,
        owner: 200,
        admin: 200,
      });
    });

    it('a removed belief: owner and admin only; a page an admin removed: admin only', async () => {
      await m.ProfileBlock.collection.insertOne({
        profileId: (await m.SocialProfile.findOne({ slug: 'open-page' }).lean())
          ._id,
        blockId: 'blk_removed1',
        section: 'beliefs',
        kind: 'paragraph',
        tabId: 'tab_removed',
        order: 0,
        currentVersionSeq: 1,
      });
      const fields = {
        blockId: 'blk_removed1',
        seq: 1,
        text: 'A removed synthetic belief.',
        authorUserId: U.owner,
        createdAt: new Date(),
        prevHash: GENESIS_HASH,
      };
      await m.BlockVersion.collection.insertOne({
        ...fields,
        hash: computeVersionHash(fields),
      });
      expect(await beliefMatrix('open-page', 'tab_removed', U.owner)).toEqual({
        guest: gone,
        member: gone,
        owner: 200,
        admin: 200,
      });
      await m.SocialProfile.collection.updateOne(
        { slug: 'named-writer' },
        { $set: { reviewStatus: 'removed' } },
      );
      expect(await beliefMatrix('named-writer', 'tab_n', U.named)).toEqual({
        guest: gone,
        member: gone,
        owner: gone,
        admin: 200,
      });
      await m.SocialProfile.collection.updateOne(
        { slug: 'named-writer' },
        { $set: { reviewStatus: 'approved' } },
      );
    });

    it('comments: moderated ones admin-only, and an anonymous author is never identified', async () => {
      const { commentId } = await comments.create(await writer(U.anon), {
        slug: 'open-page',
        tabId: 'tab_a',
        body: 'A synthetic comment by an anonymous member.',
      });
      await anchoringOn(m, tsa, fresh()).run(soon());
      for (const user of [undefined, U.named, U.owner]) {
        const receipt = await receipts.comment(
          'open-page',
          commentId,
          await viewer(user),
        );
        expect(receipt.versions[0].anchor.state).toBe('anchored');
        expect(receipt.versions[0].hashInput.included).toBe(false);
        expect(JSON.stringify(receipt)).not.toContain(U.anon);
        expect(JSON.stringify(receipt)).not.toContain('anon-writer');
        // Round 2, M-A: nothing to test a guessed id with, not even a prefix.
        const stored = await m.CommentVersion.findOne({ commentId }).lean();
        expect(JSON.stringify(receipt)).not.toContain(stored.hash.slice(0, 12));
        const claim = await m.AnchorLeaf.findById(
          `c:${String(stored._id)}`,
        ).lean();
        expect(JSON.stringify(receipt)).not.toContain(claim.salt);
      }
      const own = await receipts.comment(
        'open-page',
        commentId,
        await viewer(U.anon),
      );
      expect(own.versions[0].hashInput.included).toBe(true);

      await m.Comment.collection.updateOne(
        { commentId },
        { $set: { moderation: 'hidden' } },
      );
      const results: number[] = [];
      for (const user of [undefined, U.named, U.owner, U.anon, U.admin]) {
        results.push(
          await status(
            receipts.comment('open-page', commentId, await viewer(user)),
          ),
        );
      }
      expect(results).toEqual([gone, gone, gone, gone, 200]);
    });

    it('an anonymous member’s own belief: readers get it, without the owner’s id', async () => {
      const receipt = await receipts
        .belief('anon-writer', 'tab_none', await viewer(U.named))
        .catch((error: unknown) => error);
      // The anonymous page has no belief in the seed: the same 404 as reading.
      expect(receipt).toBeInstanceOf(NotFoundException);
      await m.BeliefTab.collection.insertOne({
        profileId: (
          await m.SocialProfile.findOne({ slug: 'anon-writer' }).lean()
        )._id,
        tabId: 'tab_anon',
        title: 'Synthetic',
        order: 0,
        reviewStatus: 'confirmed',
      });
      await m.ProfileBlock.collection.insertOne({
        profileId: (
          await m.SocialProfile.findOne({ slug: 'anon-writer' }).lean()
        )._id,
        blockId: 'blk_anon1',
        section: 'beliefs',
        kind: 'paragraph',
        tabId: 'tab_anon',
        order: 0,
        currentVersionSeq: 1,
      });
      const fields = {
        blockId: 'blk_anon1',
        seq: 1,
        text: 'An anonymous member’s synthetic belief.',
        authorUserId: U.anon,
        createdAt: new Date(),
        prevHash: GENESIS_HASH,
      };
      await m.BlockVersion.collection.insertOne({
        ...fields,
        hash: computeVersionHash(fields),
      });
      expect(
        await status(
          receipts.belief('anon-writer', 'tab_anon', await viewer()),
        ),
      ).toBe(gone);
      const forMember = await receipts.belief(
        'anon-writer',
        'tab_anon',
        await viewer(U.named),
      );
      expect(JSON.stringify(forMember)).not.toContain(U.anon);
      expect(forMember.versions[0].hashInput).toMatchObject({
        included: false,
      });
    });
  },
);
