/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- in-memory fake rows */
// Chunk 17 review round 7, the anchoring side: an empty anchor that still
// holds a tree FAILS, and a release that dies part-way keeps its time.
// Each test was written to fail on the code before its fix.
import { Logger } from '@nestjs/common';
import {
  addBlockVersion,
  anchorModels,
  type AnchorModels,
  offlineAnchoring,
  verifierFor,
} from './anchoring-harness.mocks-spec';
import { PurgeMarksService } from './purge-marks.service';
import { makeTestTsa } from './test-tsa.mocks-spec';
import { fakeModel } from '../test-support/fake-model.mocks-spec';

const tsa = makeTestTsa();
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const day = (n: number) => new Date(Date.UTC(2026, 10, 1 + n, 4));
const id = (n: number) => day(n).toISOString().slice(0, 10);

type Row = Record<string, any>;
const anchorRow = (m: AnchorModels, n: number) =>
  m.anchors.docs.find((a) => a._id === id(n)) as Row;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  jest.spyOn(Logger.prototype, 'error').mockImplementation();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function builtOn(m: AnchorModels, n: number) {
  addBlockVersion(m, { createdAt: new Date(day(n).getTime() - HOUR) });
  expect((await offlineAnchoring(m, tsa).build(day(n))).state).toBe('built');
}

describe('round 7, 2: an empty anchor that still holds a tree FAILS', () => {
  it.each([
    ['its leaves', (row: Row) => ({ leaves: row.leaves })],
    ['its root', (row: Row) => ({ merkleRoot: row.merkleRoot })],
    [
      'a TSA token',
      (row: Row) => ({
        tsa: {
          response: tsa.respond(row.merkleRoot as string, { genTime: day(0) }),
        },
      }),
    ],
    ['an OTS proof', () => ({ ots: { proof: Buffer.from([1, 2, 3]) } })],
  ])('an empty anchor holding %s fails every check', async (_what, kept) => {
    const m = anchorModels();
    await builtOn(m, 0);
    const row = anchorRow(m, 0);
    const keep = kept(row);
    for (const key of ['leaves', 'merkleRoot', 'tsa', 'ots', 'leafCount']) {
      delete row[key];
    }
    Object.assign(row, { status: 'empty', ...keep });
    // Its claims gone too, so only the tree it still holds can tell.
    m.leaves.docs.length = 0;
    const [report] = (await verifierFor(m, tsa).verifyAll(day(1))).anchors;
    for (const key of ['root', 'versions', 'tsa', 'ots', 'bitcoin'] as const) {
      expect(report[key].outcome).toBe('fail');
    }
    expect(report.root.detail).toContain('empty');
    expect(anchorRow(m, 0).lastCheck.outcome).toBe('fail');
  });
});

/** Releases anchor 0's stray claims at `at`, crashing as `crash` says. */
async function releaseWith(
  m: AnchorModels,
  at: Date,
  crash: (update: Row) => boolean,
) {
  const original = m.anchors.updateOne;
  m.anchors.updateOne = (...args: Parameters<typeof original>) => {
    if (crash(args[1])) {
      return {
        exec: () => Promise.reject(new Error('synthetic crash')),
      };
    }
    return original(...args);
  };
  jest.useFakeTimers({
    now: at,
    doNotFake: [
      'nextTick',
      'setImmediate',
      'clearImmediate',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'queueMicrotask',
      'hrtime',
      'performance',
    ],
  });
  try {
    const anchoring = offlineAnchoring(m, tsa) as unknown as {
      releaseStray: (day: string) => Promise<number>;
    };
    await expect(anchoring.releaseStray(id(0))).rejects.toThrow(
      'synthetic crash',
    );
  } finally {
    jest.useRealTimers();
    m.anchors.updateOne = original;
  }
}

describe('round 7, 4: a release keeps the time it happened', () => {
  it('a crash between the delete and the second write still leaves rescanAt, so the record stays pending', async () => {
    const m = anchorModels();
    await builtOn(m, 0);
    // A newer build BEFORE the release: only rescanAt says the release came
    // after it.
    await builtOn(m, 1);
    const v = addBlockVersion(m, {
      createdAt: new Date(day(0).getTime() - 3 * HOUR),
    });
    m.leaves.docs.push({
      _id: `b:${String(v._id)}`,
      anchorId: id(0),
      kind: 'block',
      versionId: v._id,
      versionHash: v.hash,
      versionCreatedAt: v.createdAt,
      salt: 'c'.repeat(64),
      leaseId: 'a-builder-that-crashed',
    });
    const at = new Date(day(0).getTime() + 2 * DAY);
    // The second write is the one that sets a token with the bounds.
    await releaseWith(
      m,
      at,
      (update) =>
        typeof (update.$set as Row | undefined)?.rescanToken === 'string' &&
        update.$min !== undefined,
    );
    const row = anchorRow(m, 0);
    expect(row.rescanFrom).toEqual(v.createdAt);
    expect(row.rescanToken).toBeUndefined();
    expect(row.rescanAt).toEqual(at);
    expect(
      m.leaves.docs.some((d) => String(d.versionId) === String(v._id)),
    ).toBe(false);
    // The purge verifier reads it as a release the next build will cover.
    const marks = new PurgeMarksService(
      ...([0, 0, 0, 0, 0, 0].map(() => fakeModel([])) as never as [
        never,
        never,
        never,
        never,
        never,
        never,
      ]),
      m.anchors as never,
    );
    marks.now = () => new Date(at.getTime() + HOUR);
    const missedBy = (t: Date) =>
      (
        marks as unknown as { missedBy: (at: Date) => Promise<boolean> }
      ).missedBy(t);
    await expect(missedBy(v.createdAt)).resolves.toBe(false);
  });

  it('a build that clears the point before the delete: the second write records the time again', async () => {
    const m = anchorModels();
    await builtOn(m, 0);
    const v = addBlockVersion(m, {
      createdAt: new Date(day(0).getTime() - 3 * HOUR),
    });
    m.leaves.docs.push({
      _id: `b:${String(v._id)}`,
      anchorId: id(0),
      kind: 'block',
      versionId: v._id,
      versionHash: v.hash,
      versionCreatedAt: v.createdAt,
      salt: 'c'.repeat(64),
      leaseId: 'a-builder-that-crashed',
    });
    const at = new Date(day(0).getTime() + 2 * DAY);
    // A covering build that read the old (absent) token clears the point
    // between the first write and the delete.
    const deleteMany = m.leaves.deleteMany;
    m.leaves.deleteMany = (...args: Parameters<typeof deleteMany>) => {
      const row = anchorRow(m, 0);
      for (const key of ['rescanFrom', 'rescanTo', 'rescanToken', 'rescanAt']) {
        delete row[key];
      }
      return deleteMany(...args);
    };
    jest.useFakeTimers({
      now: at,
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'queueMicrotask'],
    });
    const anchoring = offlineAnchoring(m, tsa) as unknown as {
      releaseStray: (day: string) => Promise<number>;
    };
    await expect(anchoring.releaseStray(id(0))).resolves.toBe(1);
    jest.useRealTimers();
    expect(anchorRow(m, 0)).toMatchObject({
      rescanFrom: v.createdAt,
      rescanAt: at,
      rescanToken: expect.any(String) as unknown,
    });
  });

  it('the run that finishes such a release records when it did', async () => {
    const m = anchorModels();
    await builtOn(m, 0);
    Object.assign(anchorRow(m, 0), {
      rescanFrom: new Date(day(0).getTime() - 3 * HOUR),
      rescanTo: new Date(day(0).getTime() - 3 * HOUR),
      rescanAt: new Date(day(0).getTime() + DAY),
    });
    const later = new Date(day(0).getTime() + 5 * DAY);
    const updates: Row[] = [];
    const original = m.anchors.updateOne;
    m.anchors.updateOne = (...args: Parameters<typeof original>) => {
      updates.push(args[1]);
      return original(...args);
    };
    jest.useFakeTimers({
      now: later,
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'queueMicrotask'],
    });
    await offlineAnchoring(m, tsa).run(later);
    jest.useRealTimers();
    m.anchors.updateOne = original;
    const finish = updates.find(
      (u) =>
        typeof (u.$set as Row | undefined)?.rescanToken === 'string' &&
        u.$min === undefined,
    );
    expect(finish?.$max).toEqual({ rescanAt: later });
  });
});
