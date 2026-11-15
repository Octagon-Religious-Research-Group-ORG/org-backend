/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- real Mongo rows */
// The daily anchor log (Chunk 16b) against a REAL MongoDB: its indexes,
// racing appenders (one log, each day once), append-only rows, a full
// anchoring run that appends and signs, and the Chunk 17 residual itself:
// an honest anchor DELETED from the database after publication. Needs
// MONGO_TEST_URI (a throwaway replica-set database; it is dropped); the race
// also runs on MONGO_STANDALONE_URI. Without them the suites are SKIPPED,
// never passed. No request leaves the machine; synthetic data only.
import { Logger } from '@nestjs/common';
import mongoose, { type Model, Types } from 'mongoose';
import { ANCHOR_LOG_ORIGIN } from '../src/anchoring/anchor-log-config';
import {
  AnchorLogService,
  type PublishedFetch,
} from '../src/anchoring/anchor-log.service';
import { restoreAnchorLog } from '../src/anchoring/anchor-log-restore';
import { AnchorVerifierService } from '../src/anchoring/anchor-verifier.service';
import { AnchoringService } from '../src/anchoring/anchoring.service';
import { MERKLE_SCHEME } from '../src/anchoring/merkle';
import { parseTimestamp } from '../src/anchoring/ots';
import {
  generateNoteKey,
  openNote,
  parseVerifier,
} from '../src/anchoring/signed-note';
import { CALENDAR_RESPONSES } from '../src/anchoring/step0-fixtures.mocks-spec';
import { makeTestTsa } from '../src/anchoring/test-tsa.mocks-spec';
import { AppendOnlyViolationError } from '../src/social/append-only';
import { MANAGED_SCHEMAS } from '../src/db/managed-schemas';
import { computeVersionHash, GENESIS_HASH } from '../src/social/version-chain';

const replicaUri = process.env.MONGO_TEST_URI;
const standaloneUri = process.env.MONGO_STANDALONE_URI;
const KEY = generateNoteKey(ANCHOR_LOG_ORIGIN);
const tsa = makeTestTsa();

async function connect(uri: string) {
  const conn = await mongoose.createConnection(uri).asPromise();
  await conn.dropDatabase();
  const m = {} as Record<string, Model<any>>;
  for (const { name, schema } of MANAGED_SCHEMAS) {
    m[name] = conn.model(name, schema);
    await m[name].createCollection();
    await m[name].createIndexes();
  }
  return { conn, m };
}

function logOn(m: Record<string, Model<any>>, published: () => PublishedFetch) {
  const env: Record<string, string> = {
    ANCHOR_LOG_SIGNING_KEY: KEY.privateKey,
    ANCHOR_LOG_PUBLISHED_URL: 'https://example.org/latest.txt',
    // Until the first publication only (review 2, H1).
    ANCHOR_LOG_BOOTSTRAP: '1',
  };
  const log = new AnchorLogService(
    m.AnchorLogLeaf,
    m.AnchorLogCheckpoint,
    m.TimestampAnchor,
    { get: (key: string) => env[key] } as never,
    () => Promise.resolve(published()),
  );
  log.trustedRoots = [tsa.root];
  return log;
}

async function seedDays(m: Record<string, Model<any>>, days: number) {
  for (let i = 0; i < days; i++) {
    await m.TimestampAnchor.collection.insertOne({
      _id: `2026-11-${String(10 + i)}`,
      status: 'built',
      scheme: MERKLE_SCHEME,
      merkleRoot: String(i).repeat(64).slice(0, 64).replace(/\d/g, 'a'),
      leafCount: i + 1,
      leaves: Array.from({ length: i + 1 }, (_, j) => ({
        kind: 'block',
        versionId: new Types.ObjectId(),
        versionHash: String(j % 10).repeat(64),
        leaf: String((j + 1) % 10).repeat(64),
      })),
    } as never);
  }
}

async function race(m: Record<string, Model<any>>) {
  await seedDays(m, 6);
  const none = (): PublishedFetch => ({
    ok: false,
    error: 'HTTP 404',
    nothing: true,
  });
  const reports = await Promise.all(
    [1, 2, 3].map(() => logOn(m, none).append(new Date())),
  );
  expect(reports.map((r) => r.state)).not.toContain('refused');
  const rows = await m.AnchorLogLeaf.find({}).sort({ _id: 1 }).lean();
  expect(rows.map((r) => r._id)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(new Set(rows.map((r) => r.day)).size).toBe(6);
  // Every size signed once, and one tree per size.
  const checkpoints = await m.AnchorLogCheckpoint.find({}).lean();
  expect(checkpoints.length).toBeGreaterThanOrEqual(1);
  expect(new Set(checkpoints.map((c) => c._id)).size).toBe(checkpoints.length);
  // A later run catches up any size a racer stopped short of.
  expect((await logOn(m, none).append(new Date())).size).toBe(6);
}

const describeWithMongo = replicaUri ? describe : describe.skip;

describeWithMongo('the anchor log on a real MongoDB', () => {
  jest.setTimeout(120_000);
  let conn: mongoose.Connection;
  let m: Record<string, Model<any>>;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    ({ conn, m } = await connect(String(replicaUri)));
  });

  beforeEach(async () => {
    for (const name of [
      'TimestampAnchor',
      'AnchorLeaf',
      'BlockVersion',
      'CommentVersion',
      'AnchorLogLeaf',
      'AnchorLogCheckpoint',
      'AnchorRunLock',
    ]) {
      await m[name].collection.deleteMany({});
    }
  });

  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it('creates the unique day index, and refuses a day twice', async () => {
    const indexes = await m.AnchorLogLeaf.collection.indexes();
    expect(indexes.find((i) => i.key.day === 1)?.unique).toBe(true);
    await m.AnchorLogLeaf.create({
      _id: 0,
      day: '2026-11-10',
      record: 'x',
      hash: 'a'.repeat(64),
    });
    await expect(
      m.AnchorLogLeaf.create({
        _id: 1,
        day: '2026-11-10',
        record: 'y',
        hash: 'b'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('log rows and checkpoints are append-only', async () => {
    await seedDays(m, 1);
    await logOn(m, () => ({
      ok: false,
      error: 'HTTP 404',
      nothing: true,
    })).append(new Date());
    await expect(
      m.AnchorLogLeaf.updateOne({ _id: 0 }, { $set: { record: 'z' } }),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
    await expect(m.AnchorLogCheckpoint.deleteMany({})).rejects.toBeInstanceOf(
      AppendOnlyViolationError,
    );
  });

  it('three appenders at once: one log, each day once, every size signed once', async () => {
    await race(m);
  });

  it('an anchoring run appends its day and signs a checkpoint that verifies', async () => {
    const fields = {
      blockId: 'blk_log_e2e',
      seq: 1,
      text: 'Synthetic belief.',
      authorUserId: 'user_owner',
      createdAt: new Date(Date.now() - 60 * 60_000),
      prevHash: GENESIS_HASH,
    };
    await m.BlockVersion.collection.insertOne({
      _id: new Types.ObjectId(),
      ...fields,
      hash: computeVersionHash(fields),
    });
    const settings = { enabled: true, hourUtc: 0 };
    const log = logOn(m, () => ({
      ok: false,
      error: 'HTTP 404',
      nothing: true,
    }));
    const anchoring = new AnchoringService(
      m.TimestampAnchor,
      m.AnchorLeaf,
      m.BlockVersion,
      m.CommentVersion,
      {
        settings,
        timestamp: (root: string) =>
          Promise.resolve({
            response: tsa.respond(root),
            tst: { genTime: new Date(), serial: '01' },
          }),
      } as never,
      {
        settings,
        submit: (root: string) =>
          Promise.resolve(
            Object.entries(CALENDAR_RESPONSES).map(([url, body]) => ({
              url,
              ok: true,
              tree: parseTimestamp(body, Buffer.from(root, 'hex')),
            })),
          ),
        upgrade: () => Promise.resolve({ state: 'pending' }),
      } as never,
      m.AnchorRunLock,
      log,
    );
    anchoring.retryPauseMs = 0;
    const report = await anchoring.run(new Date(), true);
    expect(report.log).toMatchObject({ state: 'appended', size: 1, signed: 1 });
    const [checkpoint] = await m.AnchorLogCheckpoint.find({}).lean();
    expect(openNote(checkpoint.note, parseVerifier(KEY.verifierKey)).ok).toBe(
      true,
    );
  });

  it('review 1, M2b: a cache lost after publication is rebuilt from the repository, and checks pass again', async () => {
    await seedDays(m, 3);
    let published: PublishedFetch = {
      ok: false,
      error: 'HTTP 404',
      nothing: true,
    };
    await logOn(m, () => published).append(new Date());
    const [newest] = await m.AnchorLogCheckpoint.find({})
      .sort({ _id: -1 })
      .limit(1)
      .lean();
    published = { ok: true, note: newest.note };
    const records = (
      await m.AnchorLogLeaf.find({}).sort({ _id: 1 }).lean()
    ).map((row) => row.record as string);
    // The cache is lost (the database restored from an older backup).
    await m.AnchorLogLeaf.collection.deleteMany({});
    await m.AnchorLogCheckpoint.collection.deleteMany({});
    const result = await restoreAnchorLog(
      m.AnchorLogLeaf,
      m.AnchorLogCheckpoint,
      { checkpointNote: newest.note, entries: records, vkey: KEY.verifierKey },
      {
        verifier: parseVerifier(KEY.verifierKey),
        origin: ANCHOR_LOG_ORIGIN,
        write: true,
        locks: m.AnchorRunLock,
      },
    );
    expect(result).toMatchObject({ state: 'ready', inserted: [0, 1, 2] });
    const view = logOn(m, () => published);
    view.beginCheck();
    expect((await view.view()).check.outcome).toBe('pass');
  });

  it('the Chunk 17 residual: an honest anchor deleted after publication FAILS', async () => {
    await seedDays(m, 3);
    let published: PublishedFetch = {
      ok: false,
      error: 'HTTP 404',
      nothing: true,
    };
    await logOn(m, () => published).append(new Date());
    const [newest] = await m.AnchorLogCheckpoint.find({})
      .sort({ _id: -1 })
      .limit(1)
      .lean();
    published = { ok: true, note: newest.note };
    const verifier = new AnchorVerifierService(
      m.TimestampAnchor,
      m.AnchorLeaf,
      m.BlockVersion,
      m.CommentVersion,
      undefined,
      logOn(m, () => published),
    );
    verifier.trustedRoots = [tsa.root];
    expect((await verifier.verifyAll(new Date())).log.outcome).toBe('pass');
    // A full-database writer removes one day outright, through the driver.
    await m.TimestampAnchor.collection.deleteOne({
      _id: '2026-11-11',
    } as never);
    const health = await new AnchorVerifierService(
      m.TimestampAnchor,
      m.AnchorLeaf,
      m.BlockVersion,
      m.CommentVersion,
      undefined,
      logOn(m, () => published),
    ).verifyAll(new Date());
    expect(health.log.outcome).toBe('fail');
    expect(health.log.detail).toMatch(/2026-11-11 is in the published log/);
    expect(health.anchors.every((a) => a.log.outcome === 'fail')).toBe(true);
    // And the log's own rows rewritten through the driver: still FAILS.
    await m.AnchorLogLeaf.collection.deleteMany({});
    const rolledBack = logOn(m, () => published);
    rolledBack.beginCheck();
    expect((await rolledBack.view()).check.detail).toMatch(
      /entries were removed/,
    );
  });
});

describe(
  standaloneUri
    ? 'the anchor log on a STANDALONE MongoDB'
    : 'the anchor log on a standalone MongoDB (SKIPPED: no MONGO_STANDALONE_URI)',
  () => {
    const run = standaloneUri ? it : it.skip;
    run(
      'needs no transaction: racing appenders still write one log',
      async () => {
        jest.spyOn(Logger.prototype, 'error').mockImplementation();
        const { conn, m } = await connect(String(standaloneUri));
        try {
          await race(m);
        } finally {
          await conn.dropDatabase();
          await conn.close();
        }
      },
      60_000,
    );
  },
);
