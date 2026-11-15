/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion -- wrapping the in-memory fake model */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Types } from 'mongoose';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { ANCHOR_LOG_ORIGIN } from './anchor-log-config';
import { readPublication, restoreAnchorLog } from './anchor-log-restore';
import { AnchorLogService } from './anchor-log.service';
import { dayRecordHash } from './day-record';
import { MERKLE_SCHEME } from './merkle';
import {
  checkpointText,
  generateNoteKey,
  parseSigner,
  parseVerifier,
  signNote,
} from './signed-note';
import { treeRoot } from './tlog';
import { RUN_LOCK_ID } from './schemas/anchor-run-lock.schema';

// Review round 1, M2b: the anchor log's cache can be rebuilt from the
// publication repository, for an honest restore from an older backup. It
// verifies the published checkpoint and that the entries reproduce its
// root BEFORE it writes anything, and it never overwrites a row.
const KEY = generateNoteKey(ANCHOR_LOG_ORIGIN);
const NOW = new Date('2026-11-20T04:00:00.000Z');
const verifier = parseVerifier(KEY.verifierKey);
const options = (extra: Record<string, unknown> = {}) => ({
  verifier,
  origin: ANCHOR_LOG_ORIGIN,
  write: true,
  now: NOW,
  locks: fakeModel([], { unique: [['_id']] }) as never,
  ...extra,
});

const built = (day: string, root: string) => ({
  _id: day,
  status: 'built',
  scheme: MERKLE_SCHEME,
  merkleRoot: root,
  leafCount: 1,
  leaves: [
    {
      kind: 'block',
      versionId: new Types.ObjectId(),
      versionHash: root,
      leaf: root,
    },
  ],
});

/** A log of 4 days, as the server kept it and the repository published it. */
async function published() {
  const models = {
    leaves: fakeModel([], { unique: [['_id'], ['day']] }),
    checkpoints: fakeModel([], { unique: [['_id']] }),
    anchors: fakeModel(
      ['a', 'b', 'c', 'd'].map((c, i) => built(`2026-11-1${i}`, c.repeat(64))),
      { unique: [['_id']] },
    ),
  };
  const env: Record<string, string> = {
    ANCHOR_LOG_SIGNING_KEY: KEY.privateKey,
    ANCHOR_LOG_PUBLISHED_URL: 'https://example.org/latest.txt',
    // Until the first publication only (review 2, H1).
    ANCHOR_LOG_BOOTSTRAP: '1',
  };
  const log = new AnchorLogService(
    models.leaves as never,
    models.checkpoints as never,
    models.anchors as never,
    { get: (k: string) => env[k] } as never,
    () => Promise.resolve({ ok: false, error: 'HTTP 404', nothing: true }),
  );
  await log.append(NOW);
  const records = models.leaves.docs.map((d) => d.record as string);
  const dir = mkdtempSync(join(tmpdir(), 'restore-'));
  writeFileSync(
    join(dir, 'latest.txt'),
    models.checkpoints.docs[0].note as string,
  );
  writeFileSync(join(dir, 'log.vkey'), `${KEY.verifierKey}\n`);
  mkdirSync(join(dir, 'entries'));
  records.forEach((text, i) =>
    writeFileSync(
      join(dir, 'entries', `${String(i).padStart(8, '0')}.txt`),
      text,
    ),
  );
  return { records, dir };
}

const fresh = () => ({
  leaves: fakeModel([], { unique: [['_id'], ['day']] }),
  checkpoints: fakeModel([], { unique: [['_id']] }),
});

function restore(
  target: ReturnType<typeof fresh>,
  dir: string,
  extra: Record<string, unknown> = {},
) {
  return restoreAnchorLog(
    target.leaves as never,
    target.checkpoints as never,
    readPublication(dir) as never,
    options(extra),
  );
}

describe('M2b: restoring the anchor log from the publication repository', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('M2b: an older backup (entries 0-1): adds 2-3 and the checkpoint, after proving the root', async () => {
    const pub = await published();
    dir = pub.dir;
    const target = fresh();
    target.leaves.docs.push(
      ...pub.records.slice(0, 2).map((record, i) => ({
        _id: i,
        day: `2026-11-1${i}`,
        record,
        hash: dayRecordHash(record).toString('hex'),
      })),
    );
    const dry = await restore(target, dir, { write: false });
    expect(dry).toMatchObject({
      state: 'ready',
      size: 4,
      kept: 2,
      inserted: [2, 3],
      checkpoint: true,
      written: false,
    });
    expect(target.leaves.docs).toHaveLength(2);
    expect(await restore(target, dir)).toMatchObject({ written: true });
    expect(target.leaves.docs.map((d) => d._id)).toEqual([0, 1, 2, 3]);
    expect(
      treeRoot(
        target.leaves.docs.map((d) => dayRecordHash(d.record as string)),
      ).toString('hex'),
    ).toBe(target.checkpoints.docs[0].root);
    // Again: nothing left to do.
    expect(await restore(target, dir)).toMatchObject({
      inserted: [],
      checkpoint: false,
    });
  });

  it('REFUSES, writing nothing, when the entries do not give the signed root', async () => {
    const pub = await published();
    dir = pub.dir;
    writeFileSync(
      join(dir, 'entries', '00000002.txt'),
      pub.records[2].replace('2026-11-12', '2026-11-19'),
    );
    const target = fresh();
    const result = await restore(target, dir);
    expect(result).toMatchObject({ state: 'refused' });
    expect((result as { reason: string }).reason).toMatch(
      /do not give the signed root/,
    );
    expect(target.leaves.docs).toHaveLength(0);
  });

  it('REFUSES a checkpoint not signed by the trusted key, or for another log', async () => {
    const pub = await published();
    dir = pub.dir;
    const root = treeRoot(pub.records.map((r) => dayRecordHash(r)));
    const other = generateNoteKey(ANCHOR_LOG_ORIGIN);
    writeFileSync(
      join(dir, 'latest.txt'),
      signNote(
        checkpointText(ANCHOR_LOG_ORIGIN, 4, root),
        parseSigner(other.privateKey),
      ),
    );
    const target = fresh();
    expect(await restore(target, dir)).toMatchObject({ state: 'refused' });
    writeFileSync(
      join(dir, 'latest.txt'),
      signNote(
        checkpointText(ANCHOR_LOG_ORIGIN, 4, root),
        parseSigner(KEY.privateKey),
      ),
    );
    expect(
      await restore(target, dir, { origin: 'orgspirituality.org/anchors/v2' }),
    ).toMatchObject({ state: 'refused' });
    expect(target.leaves.docs).toHaveLength(0);
  });

  it('REFUSES to overwrite a cached entry that differs, or a different checkpoint of that size', async () => {
    const pub = await published();
    dir = pub.dir;
    const target = fresh();
    target.leaves.docs.push({
      _id: 1,
      day: '2026-11-12',
      record: pub.records[2],
      hash: dayRecordHash(pub.records[2]).toString('hex'),
    });
    let result = await restore(target, dir);
    expect((result as { reason: string }).reason).toMatch(/entry 1 differs/);
    target.leaves.docs.length = 0;
    target.checkpoints.docs.push({ _id: 4, root: 'f'.repeat(64), note: 'x' });
    result = await restore(target, dir);
    expect((result as { reason: string }).reason).toMatch(
      /different checkpoint of size 4/,
    );
    expect(target.leaves.docs).toHaveLength(0);
  });

  it('REFUSES a repository whose log.vkey is not the trusted key, or whose entries are not day records', async () => {
    const pub = await published();
    dir = pub.dir;
    const target = fresh();
    writeFileSync(
      join(dir, 'log.vkey'),
      generateNoteKey(ANCHOR_LOG_ORIGIN).verifierKey,
    );
    expect(((await restore(target, dir)) as { reason: string }).reason).toMatch(
      /log\.vkey is not the trusted key/,
    );
    rmSync(join(dir, 'log.vkey'));
    expect(await restore(target, dir)).toMatchObject({ state: 'refused' });
    writeFileSync(join(dir, 'log.vkey'), KEY.verifierKey);
    writeFileSync(join(dir, 'entries', '00000001.txt'), 'a name\n');
    expect(((await restore(target, dir)) as { reason: string }).reason).toMatch(
      /not a day record/,
    );
    expect(target.leaves.docs).toHaveLength(0);
  });

  it('stamps a restored checkpoint with the time of the restore', async () => {
    const pub = await published();
    dir = pub.dir;
    const target = fresh();
    const before = Date.now();
    await restore(target, dir, { now: undefined });
    expect(
      (target.checkpoints.docs[0].signedAt as Date).getTime(),
    ).toBeGreaterThanOrEqual(before);
  });

  it('cannot measure a repository that is incomplete or unreadable', async () => {
    const pub = await published();
    dir = pub.dir;
    rmSync(join(dir, 'entries', '00000003.txt'));
    const target = fresh();
    expect(await restore(target, dir)).toMatchObject({
      state: 'cannot-measure',
    });
    expect(readPublication(join(dir, 'nope'))).toMatchObject({
      problem: expect.stringMatching(/latest\.txt/) as unknown,
    });
    writeFileSync(join(dir, 'entries', '00000009.txt'), 'x');
    expect(readPublication(dir)).toMatchObject({
      problem: expect.stringMatching(/entries/) as unknown,
    });
    rmSync(join(dir, 'entries'), { recursive: true });
    expect((readPublication(dir) as { entries: string[] }).entries).toEqual([]);
  });
});

describe('review 2, L2: a restore takes the anchoring run lock', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('L2: refuses while an anchoring run holds the lock, writing nothing', async () => {
    const pub = await published();
    dir = pub.dir;
    const target = fresh();
    const locks = fakeModel(
      [
        {
          _id: RUN_LOCK_ID,
          holder: 'a-run',
          until: new Date(NOW.getTime() + 60_000),
        },
      ],
      { unique: [['_id']] },
    );
    const result = await restore(target, dir, {
      locks,
      now: NOW,
      lockClock: () => NOW,
    });
    expect(result).toMatchObject({ state: 'refused' });
    expect((result as { reason: string }).reason).toMatch(
      /stop the server first/,
    );
    expect(target.leaves.docs).toHaveLength(0);
  });

  it('takes a free (or expired) lock for the restore, and frees it after', async () => {
    const pub = await published();
    dir = pub.dir;
    const target = fresh();
    const locks = fakeModel(
      [
        {
          _id: RUN_LOCK_ID,
          holder: 'dead-run',
          until: new Date(NOW.getTime() - 1),
        },
      ],
      { unique: [['_id']] },
    );
    const seen: unknown[] = [];
    const create = target.leaves.create.bind(target.leaves);
    target.leaves.create = (async (doc: Record<string, unknown>) => {
      seen.push(locks.docs[0].holder);
      return create(doc);
    }) as typeof target.leaves.create;
    expect(
      await restore(target, dir, { locks, lockClock: () => NOW }),
    ).toMatchObject({ written: true });
    expect(String(seen[0])).toMatch(/^restore-/);
    expect(locks.docs[0].holder).toBeUndefined();
  });
  it('surfaces a lock failure that is not a held lock', async () => {
    const pub = await published();
    dir = pub.dir;
    const locks = fakeModel([], { unique: [['_id']] });
    locks.updateOne = (() => {
      throw new Error('db down');
    }) as typeof locks.updateOne;
    await expect(restore(fresh(), dir, { locks })).rejects.toThrow('db down');
  });
});
