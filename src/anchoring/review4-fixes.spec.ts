/* eslint-disable @typescript-eslint/no-unsafe-member-access -- in-memory fake rows */
// Chunk 16 review round 4: one test per finding, each written to fail on
// the code before its fix.
import { Logger } from '@nestjs/common';
import {
  addBlockVersion,
  anchorModels,
  type AnchorModels,
  offlineAnchoring,
} from './anchoring-harness.mocks-spec';
import { makeTestTsa } from './test-tsa.mocks-spec';

const tsa = makeTestTsa();
const D1 = new Date('2026-11-14T04:00:00Z');
const NEXT_DAY = new Date('2026-11-15T04:00:00Z');
const at = (ms: number) => new Date(D1.getTime() + ms);
const HOUR = 60 * 60_000;

let warn: jest.SpyInstance;
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  jest.spyOn(Logger.prototype, 'error').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

const claimOf = (m: AnchorModels, versionId: unknown) =>
  m.leaves.docs.find((d) => String(d.versionId) === String(versionId));
const inTree = (m: AnchorModels, versionId: unknown) =>
  m.anchors.docs.filter((a) =>
    ((a.leaves as Array<{ versionId: unknown }>) ?? []).some(
      (l) => String(l.versionId) === String(versionId),
    ),
  );

/** Every claim is inside the tree of the anchor it names. */
function noStrayClaims(m: AnchorModels) {
  for (const claim of m.leaves.docs) {
    const anchor = m.anchors.docs.find((a) => a._id === claim.anchorId);
    expect(anchor?.status).toBe('built');
    expect(inTree(m, claim.versionId).map((a) => a._id)).toContain(
      claim.anchorId,
    );
  }
}

/** A stray claim that "lands" right before the anchor row is updated to `status`. */
function strayOnMark(
  m: AnchorModels,
  status: string,
  stray: { _id: unknown; hash: unknown; createdAt: unknown },
) {
  const update = m.anchors.updateOne;
  let injected = false;
  m.anchors.updateOne = (filter, change) => {
    if (!injected && (change as any).$set?.status === status) {
      injected = true;
      m.leaves.docs.push({
        _id: `b:${String(stray._id)}`,
        anchorId: '2026-11-14',
        kind: 'block',
        versionId: stray._id,
        versionHash: stray.hash,
        versionCreatedAt: stray.createdAt,
        salt: 'a'.repeat(64),
        leaseId: 'a-builder-that-lost-its-lease',
      });
    }
    return update(filter, change);
  };
}

describe('LOW-1: a stale builder’s late claim never strands a version', () => {
  it('the stale insert lands after the new builder built the anchor: it is released and anchored the next day', async () => {
    const m = anchorModels();
    const v1 = addBlockVersion(m, { createdAt: at(-3 * HOUR) });
    const v2 = addBlockVersion(m, { createdAt: at(-2 * HOUR) });
    // The first builder stops inside its insert…
    const insert = m.leaves.insertMany;
    let reached!: () => void;
    let release!: () => void;
    const atInsert = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    m.leaves.insertMany = async (docs, options) => {
      if (first) {
        first = false;
        reached();
        await gate;
      }
      return insert(docs, options);
    };
    const stale = offlineAnchoring(m, tsa).build(D1);
    await atInsert;
    // …its lease runs out, and a new builder (one version per batch)
    // takes over and finishes, recount and all.
    const takeover = offlineAnchoring(m, tsa);
    takeover.maxLeaves = 1;
    expect(await takeover.build(at(11 * 60_000))).toMatchObject({
      state: 'built',
      leaves: 1,
    });
    // Only now does the stale insert land: v1 is a duplicate, v2 is not.
    release();
    expect((await stale).state).toBe('busy');
    expect(inTree(m, v2._id)).toHaveLength(0);
    expect(claimOf(m, v2._id)).toBeUndefined();
    noStrayClaims(m);
    // Next day: v2 is anchored.
    expect(await offlineAnchoring(m, tsa).build(NEXT_DAY)).toMatchObject({
      state: 'built',
      leaves: 1,
    });
    expect(inTree(m, v2._id).map((a) => a._id)).toEqual(['2026-11-15']);
    expect(inTree(m, v1._id).map((a) => a._id)).toEqual(['2026-11-14']);
    noStrayClaims(m);
  });

  it('the stale insert lands while a new lease holder has not finished: its claims are kept and that holder builds them', async () => {
    const m = anchorModels();
    const v1 = addBlockVersion(m, { createdAt: at(-3 * HOUR) });
    const v2 = addBlockVersion(m, { createdAt: at(-2 * HOUR) });
    const insert = m.leaves.insertMany;
    let reached!: () => void;
    let release!: () => void;
    const atInsert = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    m.leaves.insertMany = async (docs, options) => {
      if (first) {
        first = false;
        reached();
        await gate;
      }
      return insert(docs, options);
    };
    const stale = offlineAnchoring(m, tsa).build(D1);
    await atInsert;
    // Another builder now holds the lease and has not built yet.
    const row = m.anchors.docs.find((d) => d._id === '2026-11-14')!;
    row.lease = { id: 'another-builder', until: at(30 * 60_000) };
    release();
    expect((await stale).state).toBe('busy');
    expect(m.leaves.docs).toHaveLength(2);
    // That builder's lease runs out too; the takeover builds both claims.
    expect(await offlineAnchoring(m, tsa).build(at(31 * 60_000))).toMatchObject(
      { state: 'built', leaves: 2 },
    );
    expect(inTree(m, v1._id)).toHaveLength(1);
    expect(inTree(m, v2._id)).toHaveLength(1);
    noStrayClaims(m);
  });

  it('a late claim that slips past the recount (its builder never checks again) is released by the builder that marked the anchor built', async () => {
    const m = anchorModels();
    addBlockVersion(m, { createdAt: at(-3 * HOUR) });
    const late = addBlockVersion(m, { createdAt: at(-2 * HOUR) });
    strayOnMark(m, 'built', late);
    const service = offlineAnchoring(m, tsa);
    service.maxLeaves = 1;
    expect(await service.build(D1)).toMatchObject({
      state: 'built',
      leaves: 1,
    });
    expect(claimOf(m, late._id)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('released 1 claim'),
    );
    noStrayClaims(m);
    expect(await offlineAnchoring(m, tsa).build(NEXT_DAY)).toMatchObject({
      state: 'built',
      leaves: 1,
    });
    expect(inTree(m, late._id).map((a) => a._id)).toEqual(['2026-11-15']);
  });

  it('the same when the anchor is marked empty', async () => {
    const m = anchorModels();
    const other = addBlockVersion(m, { createdAt: at(-HOUR) });
    // Budget 0: this builder claims nothing and marks the anchor empty;
    // a stale builder's claim lands right as it does.
    const service = offlineAnchoring(m, tsa);
    service.maxLeaves = 0;
    strayOnMark(m, 'empty', other);
    expect(await service.build(D1)).toMatchObject({ state: 'empty' });
    expect(claimOf(m, other._id)).toBeUndefined();
    expect(await offlineAnchoring(m, tsa).build(NEXT_DAY)).toMatchObject({
      state: 'built',
    });
    expect(inTree(m, other._id).map((a) => a._id)).toEqual(['2026-11-15']);
  });
});
