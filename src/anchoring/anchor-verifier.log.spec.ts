import { Logger } from '@nestjs/common';
import {
  addBlockVersion,
  anchorLogFor,
  anchorModels,
  type AnchorModels,
  offlineAnchoring,
  verifierFor,
} from './anchoring-harness.mocks-spec';
import { logCheckOf, NO_ANCHOR_LOG } from './anchor-verifier.service';
import { makeTestTsa } from './test-tsa.mocks-spec';

// Chunk 16b: the admin health view and every anchor report place each day
// in the PUBLISHED anchor log: pass, pending publication (cannot measure),
// or fail; and a log that does not hold fails them all.
const tsa = makeTestTsa();

describe('AnchorVerifierService and the anchor log', () => {
  let m: AnchorModels;
  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    m = anchorModels();
    addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(new Date('2026-11-14T04:00:00Z'));
    addBlockVersion(m, { createdAt: new Date('2026-11-14T10:00:00Z') });
    await offlineAnchoring(m, tsa).run(new Date('2026-11-15T04:00:00Z'));
  });
  afterEach(() => jest.restoreAllMocks());

  it('L3 (review 2): maps each place in the log to its outcome, a structured state and a reason code', () => {
    expect(logCheckOf({ state: 'published', index: 0, detail: 'in' })).toEqual({
      outcome: 'pass',
      state: 'published',
      detail: 'in',
    });
    expect(
      logCheckOf({
        state: 'pending',
        reason: 'pending-publication',
        detail: 'later',
      }),
    ).toEqual({
      outcome: 'cannot-measure',
      state: 'pending',
      reason: 'pending-publication',
      detail: 'pending publication: later',
    });
    expect(
      logCheckOf({ state: 'cannot-measure', reason: 'no-url', detail: 'x' }),
    ).toEqual({
      outcome: 'cannot-measure',
      state: 'cannot-measure',
      reason: 'no-url',
      detail: 'x',
    });
    expect(
      logCheckOf({ state: 'fail', reason: 'mismatch', detail: 'y' }),
    ).toEqual({
      outcome: 'fail',
      state: 'failed',
      reason: 'mismatch',
      detail: 'y',
    });
  });

  it('without a log: every anchor and the summary say cannot measure', async () => {
    const health = await verifierFor(m, tsa).verifyAll(
      new Date('2026-11-15T06:00:00Z'),
    );
    expect(health.log).toEqual({
      outcome: 'cannot-measure',
      detail: NO_ANCHOR_LOG,
      state: 'cannot-measure',
      size: 0,
    });
    expect(health.totals.log['cannot-measure']).toBe(2);
  });

  it('published: every day passes and the summary names the sizes', async () => {
    const logged = anchorLogFor(m, tsa);
    await logged.log.append(new Date('2026-11-15T05:00:00Z'));
    logged.publishLatest();
    const health = await verifierFor(m, tsa, undefined, logged.log).verifyAll(
      new Date('2026-11-15T06:00:00Z'),
    );
    expect(health.log).toMatchObject({
      outcome: 'pass',
      size: 2,
      publishedSize: 2,
    });
    expect(health.log.bootstrap).toBeUndefined();
    expect(health.totals.log).toEqual({
      pass: 2,
      fail: 0,
      'cannot-measure': 0,
    });
    // The other checks are as they were: the log is reported beside them.
    expect(health.anchors.every((a) => a.root.outcome === 'pass')).toBe(true);
  });

  it('not published yet: pending, counted as cannot measure', async () => {
    const logged = anchorLogFor(m, tsa);
    await logged.log.append(new Date('2026-11-15T05:00:00Z'));
    const health = await verifierFor(m, tsa, undefined, logged.log).verifyAll(
      new Date('2026-11-15T06:00:00Z'),
    );
    expect(health.log.outcome).toBe('cannot-measure');
    expect(health.log.publishedSize).toBeUndefined();
    // Review round 3, L1: still bootstrapping, so the page warns.
    expect(health.log.bootstrap).toBe(true);
    expect(health.totals.log['cannot-measure']).toBe(2);
  });

  it('an honest anchor DELETED after publication fails the log and every day', async () => {
    const logged = anchorLogFor(m, tsa);
    await logged.log.append(new Date('2026-11-15T05:00:00Z'));
    logged.publishLatest();
    m.anchors.docs.splice(
      m.anchors.docs.findIndex((d) => d._id === '2026-11-14'),
      1,
    );
    const health = await verifierFor(m, tsa, undefined, logged.log).verifyAll(
      new Date('2026-11-15T06:00:00Z'),
    );
    expect(health.log.outcome).toBe('fail');
    expect(health.anchors.map((a) => [a.anchorId, a.log.outcome])).toEqual([
      ['2026-11-15', 'fail'],
    ]);
    // Nothing else on the remaining anchor could see it.
    const [left] = health.anchors;
    expect(
      [left.root, left.versions, left.tsa, left.ots].map((c) => c.outcome),
    ).toEqual(['pass', 'pass', 'pass', 'pass']);
  });

  it('reports the log on every kind of anchor row', async () => {
    const logged = anchorLogFor(m, tsa);
    m.anchors.docs.push(
      { _id: '2026-11-16', status: 'empty' },
      { _id: '2026-11-17', status: 'building' },
      { _id: '2026-11-18', status: 'empty', merkleRoot: 'a'.repeat(64) },
    );
    await logged.log.append(new Date('2026-11-18T05:00:00Z'));
    logged.publishLatest();
    const verifier = verifierFor(m, tsa, undefined, logged.log);
    const health = await verifier.verifyAll(new Date('2026-11-18T06:00:00Z'));
    const byId = new Map(health.anchors.map((a) => [a.anchorId, a.log]));
    expect(byId.get('2026-11-16')?.outcome).toBe('pass');
    expect(byId.get('2026-11-17')?.outcome).toBe('cannot-measure');
    // An empty row holding a root is in the log as empty; the relabel
    // itself is the empty-anchor check's to catch (Chunk 17 round 7).
    const relabelled = health.anchors.find((a) => a.anchorId === '2026-11-18');
    expect(relabelled?.log.outcome).toBe('pass');
    expect(relabelled?.root.outcome).toBe('fail');
    // One anchor on its own.
    const report = await verifier.verifyAnchor(
      m.anchors.docs.find((d) => d._id === '2026-11-15') as never,
    );
    expect(report.log.outcome).toBe('pass');
  });
});

describe('AnchorVerifierService: review 2, M2, the leaves a check reads are checked at once', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('M2: a leaf list rewritten behind its root fails the anchor log check of the anchor read, before any new audit', async () => {
    const m = anchorModels();
    addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(new Date('2026-11-14T04:00:00Z'));
    const logged = anchorLogFor(m, tsa);
    await logged.log.append(new Date('2026-11-14T05:00:00Z'));
    logged.publishLatest();
    const verifier = verifierFor(m, tsa, undefined, logged.log);
    const row = m.anchors.docs[0];
    expect((await verifier.verifyAnchor(row as never)).log.outcome).toBe(
      'pass',
    );
    (row.leaves as Array<{ versionHash: string }>)[0].versionHash = 'e'.repeat(
      64,
    );
    const report = await verifier.verifyAnchor(row as never);
    expect(report.log).toMatchObject({ outcome: 'fail', reason: 'mismatch' });
  });
  it('a log with no key has no audit, and its summary says cannot measure without an audit time', async () => {
    const m = anchorModels();
    addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(new Date('2026-11-14T04:00:00Z'));
    const logged = anchorLogFor(m, tsa, {});
    const health = await verifierFor(m, tsa, undefined, logged.log).verifyAll(
      new Date('2026-11-14T06:00:00Z'),
    );
    expect(health.log).toMatchObject({
      state: 'cannot-measure',
      reason: 'no-key',
    });
    expect(health.log.auditedAt).toBeUndefined();
  });
});
