/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- in-memory fake rows */
// Chunk 16 review round 7: one test per finding, each written to fail on
// the code before its fix.
import { Logger } from '@nestjs/common';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
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

/** Models with a lock collection that two services share. */
function sharedModels() {
  const m = anchorModels();
  m.locks = fakeModel([], { unique: [['_id']] });
  return m;
}

describe('one anchoring run at a time, across every caller and instance', () => {
  it('two concurrent runs: one does the work, the other is busy and does nothing', async () => {
    const m = sharedModels();
    addBlockVersion(m, { createdAt: new Date(day(0).getTime() - HOUR) });
    const [a, b] = await Promise.all([
      offlineAnchoring(m, tsa).run(day(0)),
      offlineAnchoring(m, tsa).run(day(0)),
    ]);
    const busy = [a, b].filter((report) => report.busy === true);
    const worked = [a, b].filter((report) => report.busy !== true);
    expect(busy).toHaveLength(1);
    expect(busy[0]).toEqual({
      busy: true,
      resumed: [],
      released: [],
      build: { state: 'busy' },
      tsa: [],
      ots: [],
    });
    expect(worked).toHaveLength(1);
    expect(worked[0].build).toMatchObject({ state: 'built', leaves: 1 });
    expect(worked[0].tsa).toHaveLength(1);
  });

  it('the lock is released when a run ends, even when it throws', async () => {
    const m = sharedModels();
    addBlockVersion(m, { createdAt: new Date(day(0).getTime() - HOUR) });
    const failing = offlineAnchoring(m, tsa);
    const find = m.anchors.find;
    m.anchors.find = () => {
      throw new Error('synthetic failure inside the run');
    };
    await expect(failing.run(day(0))).rejects.toThrow('synthetic failure');
    m.anchors.find = find;
    const next = await offlineAnchoring(m, tsa).run(day(0));
    expect(next.busy).toBeUndefined();
    expect(next.build).toMatchObject({ state: 'built' });
  });

  it('a lock whose holder died (its lease ran out) is taken over', async () => {
    const m = sharedModels();
    m.locks!.docs.push({
      _id: 'anchoring-run',
      holder: 'a-run-that-died',
      until: new Date(Date.now() - 1000),
    });
    addBlockVersion(m, { createdAt: new Date(day(0).getTime() - HOUR) });
    const report = await offlineAnchoring(m, tsa).run(day(0));
    expect(report.busy).toBeUndefined();
    expect(report.build).toMatchObject({ state: 'built' });
  });

  it('a run that lost its lock stops before its next step, and says so', async () => {
    const m = sharedModels();
    addBlockVersion(m, { createdAt: new Date(day(0).getTime() - HOUR) });
    const service = offlineAnchoring(m, tsa);
    // Another run takes the lock over once this one has built.
    const build: typeof service.build = service.build.bind(service);
    service.build = async (now: Date, force?: boolean) => {
      const outcome = await build(now, force);
      const lock = m.locks!.docs[0];
      lock.holder = 'another-run';
      return outcome;
    };
    const report = await service.run(day(0));
    expect(report.interrupted).toBe(true);
    expect(report.build).toMatchObject({ state: 'built' });
    expect(report.tsa).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('lost the anchoring lock'),
    );
  });
});

describe('the lock’s own failures are loud, never a silent run', () => {
  it('a database error while taking the lock rejects the run', async () => {
    const m = sharedModels();
    m.locks!.updateOne = () => ({
      exec: () => Promise.reject(new Error('synthetic lock failure')),
    });
    await expect(offlineAnchoring(m, tsa).run(day(0))).rejects.toThrow(
      'synthetic lock failure',
    );
  });

  it('a lock another run took right after ours was written is busy', async () => {
    const m = sharedModels();
    const update = m.locks!.updateOne;
    m.locks!.updateOne = (filter, change, options) => {
      const result = update(filter, change, options);
      return {
        exec: async () => {
          const done = await result.exec();
          const lock = m.locks!.docs[0];
          if (lock) lock.holder = 'a-faster-run';
          return done;
        },
      };
    };
    expect((await offlineAnchoring(m, tsa).run(day(0))).busy).toBe(true);
  });
});

describe('LOW-1: a covering build that cleared the point in between cannot lose it', () => {
  it('the point is written again with the token, after the delete', async () => {
    const m = anchorModels();
    await builtOn(m, 0);
    await builtOn(m, 1);
    await builtOn(m, 2);
    const v = addBlockVersion(m, {
      createdAt: new Date(day(0).getTime() - 3 * HOUR),
    });
    strayClaim(m, id(0), v);
    // An earlier release's point, read by a covering build…
    Object.assign(anchorRow(m, 0), {
      rescanFrom: v.createdAt,
      rescanTo: v.createdAt,
      rescanToken: 'read-by-a-covering-build',
    });
    // …which clears it right between this release's first write and its
    // delete.
    const deleteMany = m.leaves.deleteMany;
    m.leaves.deleteMany = (filter) => {
      const row = anchorRow(m, 0);
      delete row.rescanFrom;
      delete row.rescanTo;
      delete row.rescanToken;
      return deleteMany(filter);
    };
    const report = await offlineAnchoring(m, tsa).run(day(5));
    m.leaves.deleteMany = deleteMany;
    expect(report.released).toEqual([id(0)]);
    expect(report.build).toMatchObject({ state: 'built', leaves: 1 });
    expect(treesWith(m, v._id)).toEqual([id(5)]);
  });
});

describe('LOW-2: a release that died after its delete is finished whatever its age', () => {
  it('an anchor older than the sweep window with a point but no token gets its token', async () => {
    const m = anchorModels();
    await builtOn(m, 0);
    Object.assign(anchorRow(m, 0), {
      rescanFrom: new Date(day(0).getTime() - 3 * HOUR),
      rescanTo: new Date(day(0).getTime() - 3 * HOUR),
    });
    await offlineAnchoring(m, tsa).run(
      new Date(day(0).getTime() + 60 * 24 * HOUR),
    );
    expect(anchorRow(m, 0).rescanToken).toEqual(expect.any(String));
  });
});

describe('admin health: an empty anchor is not noise', () => {
  it('an empty anchor with nothing on it passes as "nothing to anchor"', async () => {
    const m = anchorModels();
    await m.anchors.create({ _id: id(0), status: 'empty', cutoff: day(0) });
    const health = await verifierFor(m, tsa).verifyAll(day(1));
    const [report] = health.anchors;
    for (const key of ['root', 'versions', 'tsa', 'ots', 'bitcoin'] as const) {
      expect(report[key]).toEqual({
        outcome: 'pass',
        detail: 'nothing to anchor',
      });
    }
    expect(anchorRow(m, 0).lastCheck.outcome).toBe('pass');
    expect(health.global.cannotMeasureWhenLastChecked).toBe(0);
  });

  it.each([
    ['a claim', (m: AnchorModels) => strayClaim(m, id(0), addBlockVersion(m))],
    [
      'a reach-back point',
      (m: AnchorModels) =>
        Object.assign(anchorRow(m, 0), {
          resumeFrom: day(0),
          resumeOpen: true,
        }),
    ],
  ])('an empty anchor with %s stays cannot-measure', async (_what, add) => {
    const m = anchorModels();
    await m.anchors.create({ _id: id(0), status: 'empty', cutoff: day(0) });
    add(m);
    const [report] = (await verifierFor(m, tsa).verifyAll(day(1))).anchors;
    expect(report.root.outcome).toBe('cannot-measure');
  });

  it('a built anchor whose stamps are pending stays honestly cannot-measure', async () => {
    const m = anchorModels();
    await builtOn(m, 0);
    const [report] = (await verifierFor(m, tsa).verifyAll(day(0))).anchors;
    expect(report.tsa.outcome).toBe('cannot-measure');
    expect(anchorRow(m, 0).lastCheck.outcome).toBe('cannot-measure');
  });
});
