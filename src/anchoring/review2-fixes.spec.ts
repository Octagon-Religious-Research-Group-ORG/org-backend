/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- in-memory fake rows */
// Chunk 16 review round 2: one test per finding, each written to fail on
// the code before its fix.
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  addBlockVersion,
  anchorModels,
  type AnchorModels,
  offlineAnchoring,
  verifierFor,
} from './anchoring-harness.mocks-spec';
import { buildTree, leafHash, MERKLE_SCHEME } from './merkle';
import { fetchBytes } from './providers';
import * as rfc3161 from './rfc3161';
import { makeTestTsa } from './test-tsa.mocks-spec';
import { toRecord } from './version-records';

const tsa = makeTestTsa();
const DAY = 24 * 3_600_000;
const D1 = new Date('2026-11-14T04:00:00Z');
const at = (ms: number) => new Date(D1.getTime() + ms);
const sha = (hex: string) =>
  createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  jest.spyOn(Logger.prototype, 'error').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

const row = (m: AnchorModels, id: string) =>
  m.anchors.docs.find((d) => d._id === id) as Record<string, any>;

/** Makes the next "built" write throw, as a killed process would. */
function crashOnce(m: AnchorModels) {
  const update = m.anchors.updateOne;
  let crashed = false;
  m.anchors.updateOne = (filter, change) => {
    if (!crashed && (change as any).$set?.status === 'built') {
      crashed = true;
      throw new Error('process killed');
    }
    return update(filter, change);
  };
}

describe('M-A: a salted leaf (org-anchor-merkle-v2)', () => {
  it('leaf = SHA-256(0x00 || versionHash || salt), under a new scheme name', () => {
    const vh = 'a'.repeat(64);
    const salt = 'b'.repeat(64);
    expect(MERKLE_SCHEME).toBe('org-anchor-merkle-v2');
    expect(leafHash(vh, salt)).toBe(sha(`00${vh}${salt}`));
  });

  it('each claim holds its own secret salt, and the anchor its salted leaves', async () => {
    const m = anchorModels();
    const v = [addBlockVersion(m), addBlockVersion(m)];
    await offlineAnchoring(m, tsa).run(D1);
    const salts = m.leaves.docs.map((d) => d.salt as string);
    expect(salts.every((s) => /^[0-9a-f]{64}$/.test(s))).toBe(true);
    expect(new Set(salts).size).toBe(2);
    const anchor = row(m, '2026-11-14');
    for (const leaf of anchor.leaves) {
      const claim = m.leaves.docs.find(
        (d) => String(d.versionId) === String(leaf.versionId),
      ) as Record<string, any>;
      expect(leaf.leaf).toBe(leafHash(claim.versionHash, claim.salt));
    }
    expect(anchor.merkleRoot).toBe(
      buildTree(anchor.leaves.map((l: any) => l.leaf)).root,
    );
    expect(anchor.scheme).toBe('org-anchor-merkle-v2');
    expect(
      (await verifierFor(m, tsa).verifyAll(D1)).anchors[0].root.outcome,
    ).toBe('pass');
    void v;
  });

  it('an altered salt is detected', async () => {
    const m = anchorModels();
    addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(D1);
    m.leaves.docs[0].salt = 'c'.repeat(64);
    const report = (await verifierFor(m, tsa).verifyAll(D1)).anchors[0];
    expect(report.versions.detail).toContain('salted leaf');
  });
});

describe('M-B: a takeover stays within the cap, and one bad stale anchor stops nothing', () => {
  it('two crashes in a row keep the anchor at the cap, the rest going to later days', async () => {
    const m = anchorModels();
    for (let i = 0; i < 8; i++) {
      addBlockVersion(m, { createdAt: new Date(Date.UTC(2026, 8, 1 + i)) });
    }
    const service = () => {
      const s = offlineAnchoring(m, tsa);
      s.maxLeaves = 3;
      return s;
    };
    crashOnce(m);
    await expect(service().run(D1)).rejects.toThrow('process killed');
    // Taken over the same day, after the lease ran out; dies again.
    crashOnce(m);
    await expect(service().build(at(11 * 60_000))).rejects.toThrow(
      'process killed',
    );
    await service().build(at(22 * 60_000));
    const anchor = row(m, '2026-11-14');
    expect(anchor.status).toBe('built');
    expect(anchor.leaves.length).toBeLessThanOrEqual(3);
    expect(anchor.resumeFrom).toBeInstanceOf(Date);
    for (let day = 1; day <= 3; day++) await service().run(at(day * DAY));
    expect(m.leaves.docs).toHaveLength(8);
  });

  it('a stale anchor whose finish throws is logged and the run goes on', async () => {
    const m = anchorModels();
    await m.anchors.create({
      _id: '2026-11-12',
      status: 'building',
      lease: { id: 'dead', until: at(-DAY) },
      cutoff: at(-2 * DAY),
    });
    addBlockVersion(m);
    const find = m.leaves.find;
    m.leaves.find = (filter?: Record<string, unknown>) => {
      if (filter?.anchorId === '2026-11-12') throw new Error('corrupt claim');
      return find(filter);
    };
    const report = await offlineAnchoring(m, tsa).run(D1);
    expect(report.resumed).toEqual([
      { state: 'failed', anchorId: '2026-11-12', error: 'corrupt claim' },
    ]);
    expect(report.build.state).toBe('built');
    expect(report.tsa[0].outcome).toBe('granted');
  });
});

describe('M-C: the health view says what it covered', () => {
  it('page totals are labelled, and a global count covers every anchor', async () => {
    const m = anchorModels();
    addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(D1);
    await m.anchors.create({ _id: '2026-11-01', status: 'building' });
    const health = await verifierFor(m, tsa).verifyAll(D1);
    expect(health.totalsScope).toBe('page');
    expect(health.global).toMatchObject({
      anchors: 2,
      unfinished: 1,
      failedWhenLastChecked: 0,
      neverChecked: 0,
    });
    row(m, '2026-11-14').merkleRoot = 'f'.repeat(64);
    await verifierFor(m, tsa).verifyAll(D1);
    expect(
      (await verifierFor(m, tsa).verifyAll(D1)).global.failedWhenLastChecked,
    ).toBe(1);
  });
});

describe('L-a: claims are written only under a held lease, and checked against the leaves', () => {
  it('a builder that lost its lease before inserting claims none', async () => {
    const m = anchorModels();
    addBlockVersion(m);
    const findById = m.anchors.findById;
    m.anchors.findById = (id) => {
      const doc = m.anchors.docs.find((d) => d._id === id) as any;
      if (doc?.status === 'building')
        doc.lease = { id: 'thief', until: at(DAY) };
      return findById(id);
    };
    expect((await offlineAnchoring(m, tsa).build(D1)).state).toBe('busy');
    expect(m.leaves.docs).toHaveLength(0);
  });

  it('coverage flags a claim its built anchor does not hold', async () => {
    const m = anchorModels();
    addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(D1);
    const stray = addBlockVersion(m);
    await m.leaves.create({
      _id: `b:${String(stray._id)}`,
      anchorId: '2026-11-14',
      kind: 'block',
      versionId: stray._id,
      versionHash: stray.hash,
      versionCreatedAt: stray.createdAt,
      salt: 'd'.repeat(64),
    });
    const coverage = (await verifierFor(m, tsa).verifyAll(at(1000))).coverage;
    expect(coverage.outcome).toBe('fail');
    expect(coverage.detail).toContain('2026-11-14');
  });
});

describe('L-b: a build with no lease at all is stale', () => {
  it('today’s and an earlier day’s are both taken over', async () => {
    const m = anchorModels();
    addBlockVersion(m);
    await m.anchors.create({
      _id: '2026-11-13',
      status: 'building',
      cutoff: at(-DAY),
    });
    await m.anchors.create({
      _id: '2026-11-14',
      status: 'building',
      cutoff: at(-60_000),
    });
    const report = await offlineAnchoring(m, tsa).run(D1);
    expect(report.resumed.map((r) => r.state)).toEqual(['empty']);
    expect(report.build).toMatchObject({
      state: 'built',
      anchorId: '2026-11-14',
    });
  });
});

describe('L-c: the receipt cache is bounded by leaves', () => {
  it('drops an anchor when the leaves kept would pass the bound', async () => {
    const m = anchorModels();
    const a = [addBlockVersion(m), addBlockVersion(m)];
    await offlineAnchoring(m, tsa).run(D1);
    const b = [
      addBlockVersion(m, { createdAt: at(DAY / 2) }),
      addBlockVersion(m, { createdAt: at(DAY / 2) }),
    ];
    await offlineAnchoring(m, tsa).run(at(DAY));
    const verifier = verifierFor(m, tsa);
    verifier.anchorCacheLeaves = 3;
    const verify = jest.spyOn(rfc3161, 'verifyTimestampToken');
    for (const v of [a[0], b[0], a[1]]) {
      await verifier.proveVersion('block', toRecord('block', v));
    }
    expect(verify).toHaveBeenCalledTimes(3);
  });
});

describe('the streamed cap ends cleanly when the time runs out mid-stream', () => {
  it('rejects with the timeout and leaves no read hanging', async () => {
    jest.spyOn(global, 'fetch').mockImplementation((_url, init) => {
      const signal = (init as RequestInit).signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1024));
          // The body stalls; the fetch's signal errors it, as undici does.
          signal.addEventListener('abort', () =>
            controller.error(signal.reason),
          );
        },
      });
      return Promise.resolve(new Response(body));
    });
    const started = Date.now();
    await expect(fetchBytes('https://x.example.test', {}, 50)).rejects.toThrow(
      /timeout|aborted/i,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('round 2: the remaining edges', () => {
  it('a claim whose salt is not a hex value fails, it never throws', async () => {
    const m = anchorModels();
    const v = addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(D1);
    m.leaves.docs[0].salt = 'not hex';
    const proof = await verifierFor(m, tsa).proveVersion(
      'block',
      toRecord('block', v),
    );
    expect(proof.anchored && proof.checks.path.outcome).toBe('fail');
    expect(
      (await verifierFor(m, tsa).verifyAll(D1)).anchors[0].versions.detail,
    ).toContain('salted leaf');
  });

  it('a built anchor that lost its leaf count is reported, not passed', async () => {
    const m = anchorModels();
    addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(D1);
    delete row(m, '2026-11-14').leafCount;
    const coverage = (await verifierFor(m, tsa).verifyAll(D1)).coverage;
    expect(coverage.outcome).toBe('fail');
    expect(coverage.detail).toContain('no recorded leaves');
  });
});

describe('L-c: an anchor bigger than the whole bound', () => {
  it('is checked every time and never kept', async () => {
    const m = anchorModels();
    const v = [addBlockVersion(m), addBlockVersion(m)];
    await offlineAnchoring(m, tsa).run(D1);
    const verifier = verifierFor(m, tsa);
    verifier.anchorCacheLeaves = 1;
    const verify = jest.spyOn(rfc3161, 'verifyTimestampToken');
    for (const version of [v[0], v[1]]) {
      await verifier.proveVersion('block', toRecord('block', version));
    }
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
