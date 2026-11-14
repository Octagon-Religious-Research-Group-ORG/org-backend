/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- in-memory fake rows */
// Chunk 16 review round 6: one test per finding, each written to fail on
// the code before its fix.
import { Logger } from '@nestjs/common';
import {
  addBlockVersion,
  anchorModels,
  type AnchorModels,
  offlineAnchoring,
} from './anchoring-harness.mocks-spec';
import { buildTree } from './merkle';
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

type Row = Record<string, any>;
type Version = { _id: unknown; hash: unknown; createdAt: unknown };
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
const claimsOf = (m: AnchorModels, n: number) =>
  m.leaves.docs.filter((d) => d.anchorId === id(n));

function strayClaim(m: AnchorModels, anchorId: string, v: Version) {
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

describe('L1: an empty build that was capped keeps its resume point', () => {
  it('every insert hits a duplicate key while versions are left over', async () => {
    const m = anchorModels();
    const v1 = addBlockVersion(m, {
      createdAt: new Date(day(0).getTime() - 3 * HOUR),
    });
    const v2 = addBlockVersion(m, {
      createdAt: new Date(day(0).getTime() - 2 * HOUR),
    });
    // v1 is claimed by another day's batch while this builder inserts.
    const insert = m.leaves.insertMany;
    m.leaves.insertMany = async (docs, options) => {
      m.leaves.docs.push({ ...docs[0], anchorId: '2026-10-31' });
      return insert(docs, options);
    };
    const service = offlineAnchoring(m, tsa);
    service.maxLeaves = 1;
    expect(await service.build(day(0))).toMatchObject({ state: 'empty' });
    m.leaves.insertMany = insert;
    expect(anchorRow(m, 0)).toMatchObject({
      status: 'empty',
      resumeFrom: v2.createdAt,
      resumeOpen: true,
    });
    expect(treesWith(m, v1._id)).toEqual([]);
  });
});

describe('L2: a release needs the time-stamps to agree with the stored root', () => {
  /** Day 0 anchored and stamped with two versions; then rewritten. */
  async function stampedThenRewritten(keep: (row: Row) => void) {
    const m = anchorModels();
    addBlockVersion(m, { createdAt: new Date(day(0).getTime() - 3 * HOUR) });
    addBlockVersion(m, { createdAt: new Date(day(0).getTime() - 2 * HOUR) });
    const first = await offlineAnchoring(m, tsa).run(day(0));
    expect(first.tsa).toMatchObject([{ outcome: 'granted' }]);
    const row = anchorRow(m, 0);
    // A consistent rewrite: one leaf dropped, count and root recomputed.
    row.leaves = row.leaves.slice(1);
    row.leafCount = 1;
    row.merkleRoot = buildTree(
      (row.leaves as Row[]).map((l) => String(l.leaf)),
    ).root;
    keep(row);
    return m;
  }

  it.each([
    ['with the FreeTSA token', (row: Row) => row],
    [
      'with only the OpenTimestamps proof',
      (row: Row) => delete row.tsa.response,
    ],
  ])(
    'a tree rewritten after it was stamped (%s) keeps all its claims',
    async (_with, keep) => {
      const m = await stampedThenRewritten(keep);
      const before = claimsOf(m, 0).map((d) => ({ ...d }));
      expect(before).toHaveLength(2);
      const report = await offlineAnchoring(m, tsa).run(day(1));
      expect(report.released).toEqual([]);
      expect(claimsOf(m, 0)).toEqual(before);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('cannot measure'),
      );
    },
  );

  it('an unreadable FreeTSA token is cannot-measure too', async () => {
    const m = await stampedThenRewritten((row) => {
      row.tsa.response = Buffer.from('not a token');
    });
    expect((await offlineAnchoring(m, tsa).run(day(1))).released).toEqual([]);
    expect(claimsOf(m, 0)).toHaveLength(2);
  });

  it('when both agree, a stray claim is still released', async () => {
    const m = anchorModels();
    addBlockVersion(m, { createdAt: new Date(day(0).getTime() - 2 * HOUR) });
    await offlineAnchoring(m, tsa).run(day(0));
    const late = addBlockVersion(m, {
      createdAt: new Date(day(0).getTime() - 3 * HOUR),
    });
    strayClaim(m, id(0), late);
    const report = await offlineAnchoring(m, tsa).run(day(1));
    expect(report.released).toEqual([id(0)]);
    expect(treesWith(m, late._id)).toEqual([id(1)]);
  });
});

describe('L3: a crash right after the delete leaves a point that reaches the versions', () => {
  it('the released version is anchored, and the point is closed afterwards', async () => {
    const m = anchorModels();
    await builtOn(m, 0);
    await builtOn(m, 1);
    await builtOn(m, 2);
    const v = addBlockVersion(m, {
      createdAt: new Date(day(0).getTime() - 3 * HOUR),
    });
    strayClaim(m, id(0), v);
    // The release dies when it would set its token, after the delete.
    const update = m.anchors.updateOne;
    let crashed = false;
    m.anchors.updateOne = (filter, change) => {
      if (!crashed && (change.$set as Row | undefined)?.rescanToken) {
        crashed = true;
        throw new Error('synthetic crash after the delete');
      }
      return update(filter, change);
    };
    const report = await offlineAnchoring(m, tsa).run(day(5));
    m.anchors.updateOne = update;
    expect(crashed).toBe(true);
    expect(report.build).toMatchObject({ state: 'built', leaves: 1 });
    expect(treesWith(m, v._id)).toEqual([id(5)]);
    // The next run finishes the release (its token); the point stays open
    // until a real build covers it (a run with nothing new builds nothing).
    await offlineAnchoring(m, tsa).run(day(6));
    expect(anchorRow(m, 0).rescanToken).toEqual(expect.any(String));
    addBlockVersion(m, { createdAt: new Date(day(7).getTime() - HOUR) });
    expect((await offlineAnchoring(m, tsa).run(day(7))).build).toMatchObject({
      state: 'built',
    });
    expect(anchorRow(m, 0).rescanFrom).toBeUndefined();
  });
});

describe('a release that fails on the lost-lease path is logged, not thrown', () => {
  it('the stale builder reports busy, and the next run releases the claim', async () => {
    const m = anchorModels();
    addBlockVersion(m, { createdAt: new Date(day(0).getTime() - 3 * HOUR) });
    const v2 = addBlockVersion(m, {
      createdAt: new Date(day(0).getTime() - 2 * HOUR),
    });
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
    const stale = offlineAnchoring(m, tsa).build(day(0));
    await atInsert;
    const takeover = offlineAnchoring(m, tsa);
    takeover.maxLeaves = 1;
    await takeover.build(new Date(day(0).getTime() + 11 * 60_000));
    const findById = m.anchors.findById;
    m.anchors.findById = () => {
      throw new Error('synthetic failure in the release');
    };
    release();
    expect((await stale).state).toBe('busy');
    m.anchors.findById = findById;
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('synthetic failure in the release'),
    );
    expect((await offlineAnchoring(m, tsa).run(day(1))).released).toEqual([
      id(0),
    ]);
    expect(treesWith(m, v2._id)).toEqual([id(1)]);
  });
});
