// Chunk 16 review round 3: one test per finding, each written to fail on
// the code before its fix.
import { Logger } from '@nestjs/common';
import {
  addBlockVersion,
  anchorModels,
  type AnchorModels,
  offlineAnchoring,
  verifierFor,
} from './anchoring-harness.mocks-spec';
import { buildReceipt } from './receipt';
import { makeTestTsa } from './test-tsa.mocks-spec';
import { toRecord } from './version-records';

const tsa = makeTestTsa();
const D1 = new Date('2026-11-14T04:00:00Z');
const at = (ms: number) => new Date(D1.getTime() + ms);

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  jest.spyOn(Logger.prototype, 'error').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

const row = (m: AnchorModels, id: string) =>
  m.anchors.docs.find((d) => d._id === id) as Record<string, any>;

describe('MEDIUM-2: the global counts show unmeasured and stale checks', () => {
  it('counts anchors last checked as cannot-measure, and gives the oldest check', async () => {
    const m = anchorModels();
    addBlockVersion(m);
    await offlineAnchoring(m, tsa).build(D1);
    // Built but no proof yet: its last check is cannot-measure.
    const health = await verifierFor(m, tsa).verifyAll(D1);
    expect(health.global.cannotMeasureWhenLastChecked).toBe(1);
    expect(health.global.oldestCheck).toBe(D1.toISOString());
    await m.anchors.create({ _id: '2026-11-01', status: 'empty' });
    row(m, '2026-11-01').lastCheck = {
      at: new Date('2026-11-02T00:00:00Z'),
      outcome: 'cannot-measure',
    };
    const later = await verifierFor(m, tsa).verifyAll(D1, 2);
    expect(later.global.oldestCheck).toBe('2026-11-02T00:00:00.000Z');
  });
});

describe('L-1: a claim that lands while the tree is being built is never left out', () => {
  it('does not mark the anchor built when the claims changed, and a takeover includes the late one', async () => {
    const m = anchorModels();
    addBlockVersion(m);
    const late = addBlockVersion(m, { createdAt: at(-60 * 60_000) });
    const find = m.leaves.find;
    let injected = false;
    m.leaves.find = (filter?: Record<string, unknown>) => {
      const query = find(filter);
      if (injected || filter?.anchorId !== '2026-11-14') return query;
      injected = true;
      const exec = query.exec;
      // A stale builder's claim for this day lands right after our read.
      query.exec = async () => {
        const result = await exec();
        m.leaves.docs.push({
          _id: `b:${String(late._id)}`,
          anchorId: '2026-11-14',
          kind: 'block',
          versionId: late._id,
          versionHash: late.hash,
          versionCreatedAt: late.createdAt,
          salt: 'a'.repeat(64),
          leaseId: 'stale',
        });
        return result;
      };
      return query;
    };
    // The late version is excluded from this builder's candidates.
    const service = offlineAnchoring(m, tsa);
    service.maxLeaves = 1;
    expect((await service.build(D1)).state).toBe('busy');
    expect(row(m, '2026-11-14').status).toBe('building');
    expect(m.leaves.docs.every((d) => typeof d.leaseId === 'string')).toBe(
      true,
    );
    const report = await offlineAnchoring(m, tsa).build(at(11 * 60_000));
    expect(report).toMatchObject({ state: 'built', leaves: 2 });
  });
});

describe('L-2: the receipt reports the anchor’s own scheme, and no salt it lacks', () => {
  it('reads both from the stored rows', async () => {
    const m = anchorModels();
    const v = addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(D1);
    row(m, '2026-11-14').scheme = 'org-anchor-merkle-v2-test';
    delete m.leaves.docs[0].salt;
    const record = toRecord('block', v);
    const proof = await verifierFor(m, tsa).proveVersion('block', record);
    expect(proof.anchored && proof.salt).toBeUndefined();
    const [version] = buildReceipt(
      { type: 'belief-text', page: 'p', tabId: 't' },
      [{ kind: 'block', record, proof, disclose: 'full' }],
      { isAdmin: true },
    ).versions;
    expect(version.salt).toBeUndefined();
    expect(
      version.anchor.state === 'anchored' && version.anchor.merkleScheme,
    ).toBe('org-anchor-merkle-v2-test');
  });
});
