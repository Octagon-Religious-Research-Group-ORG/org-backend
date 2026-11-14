// Chunk 16 review round 4, follow-up: a stale builder that dies between its
// insert and its re-check leaves claims in a finished anchor that are in
// no tree. Each run sweeps for them. Written to fail on the code before.
import { Logger } from '@nestjs/common';
import {
  addBlockVersion,
  anchorModels,
  type AnchorModels,
  offlineAnchoring,
} from './anchoring-harness.mocks-spec';
import { makeTestTsa } from './test-tsa.mocks-spec';

const tsa = makeTestTsa();
const DAY = 24 * 60 * 60_000;
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

const treesWith = (m: AnchorModels, versionId: unknown) =>
  m.anchors.docs
    .filter((a) =>
      ((a.leaves as Array<{ versionId: unknown }>) ?? []).some(
        (l) => String(l.versionId) === String(versionId),
      ),
    )
    .map((a) => a._id);

/** What a builder that died after its insert, before its re-check, leaves. */
function crashedClaim(
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

async function builtOn(m: AnchorModels, n: number) {
  addBlockVersion(m, { createdAt: new Date(day(n).getTime() - HOUR) });
  expect((await offlineAnchoring(m, tsa).build(day(n))).state).toBe('built');
}

describe('each run sweeps finished anchors for claims outside their tree', () => {
  it('a stale builder crashed after its insert: the next run releases the claim and anchors the version in its tree', async () => {
    const m = anchorModels();
    await builtOn(m, 0);
    const v = addBlockVersion(m, {
      createdAt: new Date(day(0).getTime() - 3 * HOUR),
    });
    crashedClaim(m, id(0), v);
    addBlockVersion(m, { createdAt: new Date(day(1).getTime() - HOUR) });
    const report = await offlineAnchoring(m, tsa).run(day(1));
    expect(report.released).toEqual([id(0)]);
    expect(report.build).toMatchObject({ state: 'built', leaves: 2 });
    expect(treesWith(m, v._id)).toEqual([id(1)]);
  });

  it('a version released from an anchor older than the look-back is still anchored in the next tree', async () => {
    const m = anchorModels();
    await builtOn(m, 0);
    await builtOn(m, 1);
    await builtOn(m, 2);
    const v = addBlockVersion(m, {
      createdAt: new Date(day(0).getTime() - 3 * HOUR),
    });
    crashedClaim(m, id(0), v);
    addBlockVersion(m, { createdAt: new Date(day(5).getTime() - HOUR) });
    const report = await offlineAnchoring(m, tsa).run(day(5));
    expect(report.released).toEqual([id(0)]);
    expect(report.build).toMatchObject({ state: 'built', leaves: 2 });
    expect(treesWith(m, v._id)).toEqual([id(5)]);
    // Once covered, the rescan point is cleared: the next batch is normal.
    expect(
      m.anchors.docs.find((a) => a._id === id(0))?.rescanFrom,
    ).toBeUndefined();
  });

  it('is bounded: the last 30 days, plus older anchors whose last check was not a pass', async () => {
    const m = anchorModels();
    await builtOn(m, 0);
    await builtOn(m, 1);
    const old = addBlockVersion(m, {
      createdAt: new Date(day(0).getTime() - 2 * HOUR),
    });
    const flagged = addBlockVersion(m, {
      createdAt: new Date(day(1).getTime() - 2 * HOUR),
    });
    crashedClaim(m, id(0), old);
    crashedClaim(m, id(1), flagged);
    const row = m.anchors.docs.find((a) => a._id === id(1)) as Record<
      string,
      any
    >;
    row.lastCheck = { at: day(2), outcome: 'fail', claimCountOnly: true };
    const report = await offlineAnchoring(m, tsa).run(
      new Date(day(1).getTime() + 40 * DAY),
    );
    expect(report.released).toEqual([id(1)]);
    expect(
      m.leaves.docs.some(
        (d) => String(d.versionId) === String(old._id) && d.anchorId === id(0),
      ),
    ).toBe(true);
  });

  it('a claim MISSING from a built anchor is not a release (the verifier reports it)', async () => {
    const m = anchorModels();
    await builtOn(m, 0);
    m.leaves.docs.length = 0;
    const report = await offlineAnchoring(m, tsa).run(day(1));
    expect(report.released).toEqual([]);
  });

  it('one anchor whose sweep fails does not stop the others', async () => {
    const m = anchorModels();
    await builtOn(m, 0);
    await builtOn(m, 1);
    crashedClaim(
      m,
      id(0),
      addBlockVersion(m, { createdAt: new Date(day(0).getTime() - 2 * HOUR) }),
    );
    crashedClaim(
      m,
      id(1),
      addBlockVersion(m, { createdAt: new Date(day(1).getTime() - 2 * HOUR) }),
    );
    const count = m.leaves.countDocuments;
    m.leaves.countDocuments = (filter?: Record<string, unknown>) =>
      filter?.anchorId === id(0)
        ? { exec: () => Promise.reject(new Error('synthetic read failure')) }
        : count(filter);
    const report = await offlineAnchoring(m, tsa).run(day(2));
    expect(report.released).toEqual([id(1)]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('synthetic read failure'),
    );
  });
});
