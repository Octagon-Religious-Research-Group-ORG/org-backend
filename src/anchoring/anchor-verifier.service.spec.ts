/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- in-memory fake rows */
import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import {
  addBlockVersion,
  addCommentVersion,
  anchorModels,
  type AnchorModels,
  offlineAnchoring,
  verifierFor,
} from './anchoring-harness.mocks-spec';
import { checkOts, checkTsa } from './anchor-verifier.service';
import { leafHash, nodeHash, rootFromPath } from './merkle';
import { parseDetached, serializeDetached } from './ots';
import { FREETSA_RESPONSE } from './step0-fixtures.mocks-spec';
import { makeTestTsa } from './test-tsa.mocks-spec';
import { computeVersionHash } from '../social/version-chain';
import { toRecord } from './version-records';

const NOW = new Date('2026-11-14T04:00:00Z');
const tsa = makeTestTsa();

describe('AnchorVerifierService', () => {
  let m: AnchorModels;
  let blocks: Array<Record<string, any>>;
  let comment: Record<string, any>;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    m = anchorModels();
    blocks = [addBlockVersion(m), addBlockVersion(m), addBlockVersion(m)];
    comment = addCommentVersion(m);
    await offlineAnchoring(m, tsa).run(NOW);
  });
  afterEach(() => jest.restoreAllMocks());

  const row = () => m.anchors.docs[0] as Record<string, any>;
  const verify = () => verifierFor(m, tsa).verifyAll(NOW);
  const report = async () => (await verify()).anchors[0];

  it('an untouched anchor passes every check it can make, and says what it cannot', async () => {
    const health = await verify();
    expect(health.checkedAt).toBe(NOW.toISOString());
    const [r] = health.anchors;
    expect(r).toMatchObject({
      anchorId: '2026-11-14',
      status: 'built',
      leaves: 4,
      root: { outcome: 'pass' },
      versions: { outcome: 'pass' },
      tsa: { outcome: 'pass' },
      ots: { outcome: 'pass' },
      bitcoin: {
        outcome: 'cannot-measure',
        detail: 'not yet in Bitcoin (calendars pending)',
      },
    });
    expect(r.ots.detail).toContain('4 calendar(s) pending');
    expect(health.coverage.outcome).toBe('pass');
    expect(health.totals.bitcoin).toEqual({
      pass: 0,
      fail: 0,
      'cannot-measure': 1,
    });
    expect(health.totals.tsa).toEqual({
      pass: 1,
      fail: 0,
      'cannot-measure': 0,
    });
  });

  it('an edited version text is detected', async () => {
    blocks[1].text = 'Edited after the fact.';
    expect((await report()).versions).toMatchObject({
      outcome: 'fail',
      detail: expect.stringContaining('its fields no longer give its hash'),
    });
  });

  it('a rewritten version with a recomputed hash is detected: it is no longer the anchored leaf', async () => {
    blocks[1].text = 'Rewritten.';
    blocks[1].hash = computeVersionHash(blocks[1] as never);
    expect((await report()).versions.detail).toContain(
      'stored hash differs from the anchored one',
    );
  });

  it('a deleted version is detected', async () => {
    m.comments.docs.splice(0, 1);
    expect((await report()).versions.detail).toContain('version missing');
  });

  it('an edited leaf list is detected (the root no longer rebuilds, the claims disagree)', async () => {
    row().leaves[0].leaf = 'e'.repeat(64);
    const r = await report();
    expect(r.root).toEqual({
      outcome: 'fail',
      detail: 'the leaves do not rebuild the stored root',
    });
    expect(r.versions.detail).toContain('salted leaf does not match');
    row().leaves[1].versionHash = 'e'.repeat(64);
    expect((await report()).versions.detail).toContain(
      'not claimed by this anchor with this hash',
    );
  });

  it('an extra or missing claim is detected', async () => {
    await m.leaves.create({
      _id: 'b:extra',
      anchorId: '2026-11-14',
      versionHash: 'a'.repeat(64),
    });
    expect((await report()).versions.detail).toContain('5 claims for 4 leaves');
  });

  it('a changed root is detected by the tree AND by both proofs', async () => {
    row().merkleRoot = 'c'.repeat(64);
    const r = await report();
    expect(r.root.outcome).toBe('fail');
    expect(r.tsa).toEqual({
      outcome: 'fail',
      detail: 'imprint does not match',
    });
    expect(r.ots).toEqual({
      outcome: 'fail',
      detail: 'the proof is for another digest',
    });
  });

  it('a built anchor stripped of its root or leaves fails, never "pending"', async () => {
    delete row().merkleRoot;
    let r = await report();
    expect([r.root.outcome, r.tsa.outcome, r.ots.outcome]).toEqual([
      'fail',
      'fail',
      'fail',
    ]);
    row().merkleRoot = 'c'.repeat(64);
    delete row().leaves;
    r = await report();
    expect(r.leaves).toBe(0);
    expect(r.root.outcome).toBe('fail');
  });

  it('a replaced or broken token is detected', async () => {
    row().tsa.response = FREETSA_RESPONSE;
    expect((await report()).tsa.outcome).toBe('fail');
    row().tsa.response = Buffer.from('not a token');
    expect((await report()).tsa.detail).toContain('Not a time-stamp response');
    row().tsa.response = tsa.respond('a'.repeat(64), { noToken: true });
    expect((await report()).tsa).toEqual({
      outcome: 'fail',
      detail: 'the response holds no token',
    });
  });

  it('a broken proof is detected', async () => {
    row().ots.proof = Buffer.from('nope');
    expect((await report()).ots.detail).toContain('unreadable proof');
  });

  it('with the FreeTSA root pinned (production), a synthetic token is NOT trusted', async () => {
    const real = verifierFor(m, tsa);
    real.trustedRoots = [];
    expect((await real.verifyAll(NOW)).anchors[0].tsa).toEqual({
      outcome: 'fail',
      detail: 'not signed by a trusted TSA',
    });
  });

  it('a missing token or proof cannot be measured; it is never a pass', async () => {
    delete row().tsa.response;
    delete row().ots.proof;
    const r = await report();
    expect(r.tsa).toEqual({
      outcome: 'cannot-measure',
      detail: 'no FreeTSA token yet',
    });
    expect(r.ots.outcome).toBe('cannot-measure');
    expect(r.bitcoin.outcome).toBe('cannot-measure');
    const health = await verify();
    expect(health.totals.tsa['cannot-measure']).toBe(1);
  });

  it('a building or empty anchor has nothing to verify yet, and says so', async () => {
    await m.anchors.create({ _id: '2026-11-15', status: 'building' });
    await m.anchors.create({ _id: '2026-11-16', status: 'empty' });
    const { anchors } = await verify();
    expect(anchors.map((a) => [a.anchorId, a.root.detail])).toEqual([
      ['2026-11-16', 'anchor holds no version'],
      ['2026-11-15', 'still being built'],
      ['2026-11-14', 'the leaves rebuild the stored root'],
    ]);
  });

  it('names a version older than the newest cutoff that no anchor holds', async () => {
    const stray = addBlockVersion(m, {
      createdAt: new Date('2026-11-01T00:00:00Z'),
    });
    const stray2 = addCommentVersion(m, {
      createdAt: new Date('2026-11-01T00:00:00Z'),
    });
    const { coverage } = await verify();
    expect(coverage.outcome).toBe('fail');
    expect(coverage.detail).toContain(`b:${String(stray._id)}`);
    expect(coverage.detail).toContain(`c:${String(stray2._id)}`);
  });

  it('with no anchor yet, coverage cannot be measured', async () => {
    const empty = anchorModels();
    const health = await verifierFor(empty, tsa).verifyAll();
    expect(health.anchors).toEqual([]);
    expect(health.coverage).toEqual({
      outcome: 'cannot-measure',
      detail: 'no anchor built yet',
    });
  });

  describe('proveVersion (for receipts)', () => {
    const prove = (kind: 'block' | 'comment', doc: Record<string, any>) =>
      verifierFor(m, tsa).proveVersion(kind, toRecord(kind, doc as never));

    it('gives the leaf and a path that leads to the anchored root, with every check passing', async () => {
      const proof = await prove('block', blocks[0]);
      if (!proof.anchored) throw new Error('expected anchored');
      expect(proof.anchorId).toBe('2026-11-14');
      expect(proof.leaf).toBe(leafHash(blocks[0].hash, proof.salt as string));
      expect(rootFromPath(proof.leaf, proof.path)).toBe(proof.root);
      expect(proof.root).toBe(row().merkleRoot);
      expect(Object.values(proof.checks).map((c) => c.outcome)).toEqual([
        'pass',
        'pass',
        'pass',
        'pass',
      ]);
      const c = await prove('comment', comment);
      expect(c.anchored && c.checks.hash.outcome).toBe('pass');
    });

    it('a version not anchored, or in a batch still being built, is honestly pending', async () => {
      const fresh = addBlockVersion(m, {
        createdAt: new Date('2026-11-14T12:00:00Z'),
      });
      expect(await prove('block', fresh)).toEqual({ anchored: false });
      row().status = 'building';
      expect(await prove('block', blocks[0])).toEqual({ anchored: false });
    });

    it('an edited version fails its hash check', async () => {
      const proof = await prove('block', { ...blocks[0], text: 'Changed.' });
      expect(proof.anchored && proof.checks.hash.outcome).toBe('fail');
    });

    it('an altered path (a sibling in the leaf list) fails', async () => {
      const proof = await prove('block', blocks[0]);
      if (!proof.anchored) throw new Error('expected anchored');
      const sibling = proof.path[0].hash;
      const at = row().leaves.findIndex((l: any) => l.leaf === sibling);
      row().leaves[at].leaf = 'd'.repeat(64);
      const again = await prove('block', blocks[0]);
      expect(again.anchored && again.checks.path).toEqual({
        outcome: 'fail',
        detail: 'the path does not lead to the anchored root',
      });
    });

    it('a claim whose anchor was deleted fails, it is not "pending"', async () => {
      m.anchors.docs.splice(0, 1);
      const proof = await prove('block', blocks[0]);
      expect(proof.anchored && proof.checks.path).toEqual({
        outcome: 'fail',
        detail: 'the anchor this version was claimed by is missing',
      });
      expect(proof.anchored && proof.checks.tsa.outcome).toBe('cannot-measure');
    });

    it('an anchor whose leaves are unusable fails the path', async () => {
      row().leaves = [];
      const proof = await prove('block', blocks[0]);
      expect(proof.anchored && proof.checks.path.outcome).toBe('fail');
    });
  });
});

describe('the proof checks on their own', () => {
  const root = nodeHash('1'.repeat(64), '2'.repeat(64));

  it('checkTsa', () => {
    expect(checkTsa(undefined, root, [tsa.root]).outcome).toBe(
      'cannot-measure',
    );
    expect(checkTsa(tsa.respond(root), root, [tsa.root])).toMatchObject({
      outcome: 'pass',
    });
    expect(
      checkTsa(tsa.respond(root, { signerByKeyId: true }), root, [tsa.root])
        .outcome,
    ).toBe('cannot-measure');
  });

  it('checkOts reports a Bitcoin attestation it cannot check without a node', () => {
    const tree = {
      msg: Buffer.from(root, 'hex'),
      attestations: [{ kind: 'bitcoin' as const, height: 870_123 }],
      ops: [],
    };
    const proof = serializeDetached(Buffer.from(root, 'hex'), tree);
    expect(parseDetached(proof).digest.toString('hex')).toBe(root);
    const { ots, bitcoin } = checkOts(proof, root);
    expect(ots.outcome).toBe('pass');
    expect(bitcoin).toEqual({
      outcome: 'cannot-measure',
      detail:
        'claims block 870123; the block header is not checked here (no Bitcoin node): check with the ots client',
    });
    expect(checkOts(proof, '0'.repeat(64)).bitcoin.outcome).toBe(
      'cannot-measure',
    );
  });

  it('a version id that is not one of ours is simply not anchored', async () => {
    const m = anchorModels();
    const proof = await verifierFor(m, tsa).proveVersion('block', {
      _id: new Types.ObjectId(),
      key: 'x',
      seq: 1,
      text: 't',
      authorUserId: 'u',
      createdAt: NOW,
      prevHash: '0'.repeat(64),
      hash: '1'.repeat(64),
    });
    expect(proof).toEqual({ anchored: false });
  });
});
