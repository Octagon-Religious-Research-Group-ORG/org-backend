// Chunk 16 review round 5: one test per finding, each written to fail on
// the code before its fix.
import { Logger } from '@nestjs/common';
import {
  addBlockVersion,
  anchorModels,
  type AnchorModels,
  offlineAnchoring,
  verifierFor,
} from './anchoring-harness.mocks-spec';
import { makeTestTsa } from './test-tsa.mocks-spec';

const tsa = makeTestTsa();
const HOUR = 60 * 60_000;
const day = (n: number) => new Date(Date.UTC(2026, 10, 1 + n, 4));
const id = (n: number) => day(n).toISOString().slice(0, 10);

let error: jest.SpyInstance;
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

type Row = Record<string, unknown>;
const anchorRow = (m: AnchorModels, n: number) =>
  m.anchors.docs.find((a) => a._id === id(n)) as Row;
const treesWith = (m: AnchorModels, versionId: unknown) =>
  m.anchors.docs
    .filter((a) =>
      ((a.leaves as Array<{ versionId: unknown }>) ?? []).some(
        (l) => String(l.versionId) === String(versionId),
      ),
    )
    .map((a) => a._id);

async function builtOn(m: AnchorModels, n: number) {
  addBlockVersion(m, { createdAt: new Date(day(n).getTime() - HOUR) });
  expect((await offlineAnchoring(m, tsa).build(day(n))).state).toBe('built');
}

/** An earlier day whose builder died before claiming anything. */
async function staleBuilding(m: AnchorModels, n: number) {
  await m.anchors.create({
    _id: id(n),
    status: 'building',
    cutoff: new Date(day(n).getTime() - 2 * 60_000),
  });
}

/** A claim a crashed builder left in a finished anchor. */
function strayClaim(
  m: AnchorModels,
  anchorId: string,
  v: { _id: unknown; hash: unknown; createdAt: unknown },
) {
  m.leaves.docs.push({
    _id: `b:${String(v._id)}`,
    anchorId,
    kind: 'block',
    versionId: v._id,
    versionHash: v.hash,
    versionCreatedAt: v.createdAt,
    salt: 'c'.repeat(64),
    leaseId: 'a-builder-that-crashed',
  });
}

describe('LOW-A: a reach-back point is cleared only by a build that covered it', () => {
  it('a resumed earlier day does not clear a later anchor’s rescan point it never covered', async () => {
    const m = anchorModels();
    await builtOn(m, 0);
    await staleBuilding(m, 1);
    await builtOn(m, 2);
    await builtOn(m, 3);
    await builtOn(m, 4);
    // Day 2 released a version newer than day 1's cutoff, older than the
    // look-back of the next build.
    const v = addBlockVersion(m, {
      createdAt: new Date(day(2).getTime() - 3 * HOUR),
    });
    Object.assign(anchorRow(m, 2), {
      rescanFrom: v.createdAt,
      rescanTo: v.createdAt,
      rescanToken: 'released-earlier',
    });
    const report = await offlineAnchoring(m, tsa).run(day(5));
    expect(report.resumed).toMatchObject([{ anchorId: id(1) }]);
    expect(report.build).toMatchObject({ state: 'built', leaves: 1 });
    expect(treesWith(m, v._id)).toEqual([id(5)]);
    expect(anchorRow(m, 2).rescanFrom).toBeUndefined();
  });

  it('a capped resumed earlier day is honoured after a later anchor exists', async () => {
    const m = anchorModels();
    await builtOn(m, 0);
    await staleBuilding(m, 3);
    await builtOn(m, 4);
    // Two versions in day 3's range that landed late (after day 4 was
    // built); day 4 then released v1, which pulls the next range open.
    const v1 = addBlockVersion(m, {
      createdAt: new Date(day(3).getTime() - 4 * HOUR),
    });
    const v2 = addBlockVersion(m, {
      createdAt: new Date(day(3).getTime() - 3 * HOUR),
    });
    Object.assign(anchorRow(m, 4), {
      rescanFrom: v1.createdAt,
      rescanTo: v1.createdAt,
      rescanToken: 'released-earlier',
    });
    const service = offlineAnchoring(m, tsa);
    service.maxLeaves = 1;
    const report = await service.run(day(5));
    // Day 3 is resumed and capped: v1 now, v2 left for later.
    expect(report.resumed).toMatchObject([
      { state: 'built', anchorId: id(3), leaves: 1 },
    ]);
    expect(treesWith(m, v1._id)).toEqual([id(3)]);
    // Day 4 is the newest built anchor, but day 3's leftover still counts.
    expect(report.build).toMatchObject({ state: 'built', leaves: 1 });
    expect(treesWith(m, v2._id)).toEqual([id(5)]);
    // Covered by day 5: no longer pulls later batches back.
    expect(anchorRow(m, 3).resumeOpen).toBeUndefined();
    expect(anchorRow(m, 3).resumeFrom).toBeInstanceOf(Date);
  });
});

describe('LOW-B: a release never destroys evidence', () => {
  it.each([
    ['its root', (row: Row) => (row.merkleRoot = 'f'.repeat(64))],
    ['its leaf list', (row: Row) => (row.leaves = (row.leaves as []).slice(1))],
    [
      'one leaf, to something that is not a hash',
      (row: Row) => ((row.leaves as Row[])[0].leaf = 'not-a-hash'),
    ],
  ])(
    'an anchor whose tree does not rebuild (%s tampered) keeps every claim and still fails its check',
    async (_what, tamper) => {
      const m = anchorModels();
      addBlockVersion(m, { createdAt: new Date(day(0).getTime() - 2 * HOUR) });
      await builtOn(m, 0);
      tamper(anchorRow(m, 0));
      const late = addBlockVersion(m, {
        createdAt: new Date(day(0).getTime() - 3 * HOUR),
      });
      strayClaim(m, id(0), late);
      const before = m.leaves.docs.map((d) => ({ ...d }));
      const report = await offlineAnchoring(m, tsa).run(day(1));
      expect(report.released).toEqual([]);
      expect(m.leaves.docs.filter((d) => d.anchorId === id(0))).toEqual(
        before.filter((d) => d.anchorId === id(0)),
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('cannot measure'),
      );
      const health = await verifierFor(m, tsa).verifyAll(day(1));
      const checked = health.anchors.find((a) => a.anchorId === id(0));
      expect(checked?.root.outcome).toBe('fail');
    },
  );

  it('skips an anchor whose last check failed for a reason other than the claim count', async () => {
    const m = anchorModels();
    const v = addBlockVersion(m, {
      createdAt: new Date(day(0).getTime() - 2 * HOUR),
    });
    await offlineAnchoring(m, tsa).build(day(0));
    strayClaim(
      m,
      id(0),
      addBlockVersion(m, { createdAt: new Date(day(0).getTime() - 3 * HOUR) }),
    );
    // The anchored version's text was changed afterwards.
    (m.blocks.docs.find((d) => d._id === v._id) as Row).text = 'changed';
    await verifierFor(m, tsa).verifyAll(day(0));
    expect(anchorRow(m, 0).lastCheck).toMatchObject({ outcome: 'fail' });
    const report = await offlineAnchoring(m, tsa).run(day(1));
    expect(report.released).toEqual([]);
    expect(m.leaves.docs.filter((d) => d.anchorId === id(0))).toHaveLength(2);
  });

  it('releases when the claim count is the only failure', async () => {
    const m = anchorModels();
    await builtOn(m, 0);
    strayClaim(
      m,
      id(0),
      addBlockVersion(m, { createdAt: new Date(day(0).getTime() - 3 * HOUR) }),
    );
    await verifierFor(m, tsa).verifyAll(day(0));
    expect(anchorRow(m, 0).lastCheck).toMatchObject({
      outcome: 'fail',
      claimCountOnly: true,
    });
    expect((await offlineAnchoring(m, tsa).run(day(1))).released).toEqual([
      id(0),
    ]);
  });
});

describe('LOW-C: a failure after the build neither rejects the run nor fails the anchor', () => {
  it('the run resolves, stamping still happens, and the anchor is reported built', async () => {
    const m = anchorModels();
    addBlockVersion(m, { createdAt: new Date(day(0).getTime() - HOUR) });
    const findOne = m.leaves.findOne;
    m.leaves.findOne = () => {
      throw new Error('synthetic failure after the build');
    };
    const report = await offlineAnchoring(m, tsa).run(day(0));
    m.leaves.findOne = findOne;
    expect(report.build).toMatchObject({ state: 'built', anchorId: id(0) });
    expect(report.tsa).toHaveLength(1);
    expect(anchorRow(m, 0).status).toBe('built');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('synthetic failure after the build'),
    );
  });
});
