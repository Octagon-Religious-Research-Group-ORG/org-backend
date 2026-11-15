/* eslint-disable @typescript-eslint/unbound-method -- the set-up's helpers are closures, not methods */
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { ANCHOR_LOG_ORIGIN } from './anchor-log-config';
import {
  AnchorLogService,
  LOG_SETTLE_MS,
  PUBLISHED_CACHE_MS,
  type PublishedFetch,
} from './anchor-log.service';
import {
  dayRecordHash,
  formatDayRecord,
  leafSetHash,
  parseDayRecord,
} from './day-record';
import { MERKLE_SCHEME } from './merkle';
import {
  checkpointText,
  generateNoteKey,
  openNote,
  parseCheckpoint,
  parseSigner,
  parseVerifier,
  signNote,
} from './signed-note';
import { makeTestTsa } from './test-tsa.mocks-spec';
import { treeRoot, verifyConsistency, verifyInclusion } from './tlog';

const KEY = generateNoteKey(ANCHOR_LOG_ORIGIN);
const OTHER = generateNoteKey(ANCHOR_LOG_ORIGIN);
const NOW = new Date('2026-11-20T04:00:00.000Z');
const DAY = 86_400_000;
const tsa = makeTestTsa();

/** Synthetic leaves for a built anchor (the log binds the list, L3). */
const leavesOf = (day: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    kind: 'block',
    versionId: new Types.ObjectId(),
    versionHash: createHash('sha256').update(`${day} v${i}`).digest('hex'),
    leaf: createHash('sha256').update(`${day} l${i}`).digest('hex'),
  }));

function built(day: string, root: string, leafCount = 2, genTime?: Date) {
  return {
    _id: day,
    status: 'built',
    scheme: MERKLE_SCHEME,
    merkleRoot: root,
    leafCount,
    leaves: leavesOf(day, leafCount),
    ...(genTime ? { tsa: { response: tsa.respond(root, { genTime }) } } : {}),
  };
}

function setUp(
  env: Record<string, string | undefined> = {
    ANCHOR_LOG_SIGNING_KEY: KEY.privateKey,
    ANCHOR_LOG_PUBLISHED_URL: 'https://example.org/latest.txt',
    ANCHOR_LOG_BOOTSTRAP: '1',
  },
  anchors: Array<Record<string, unknown>> = [
    built('2026-11-14', 'a'.repeat(64)),
    { _id: '2026-11-15', status: 'empty' },
    built('2026-11-16', 'b'.repeat(64)),
    { _id: '2026-11-17', status: 'building' },
  ],
) {
  const models = {
    leaves: fakeModel([], { unique: [['_id'], ['day']] }),
    checkpoints: fakeModel([], { unique: [['_id']] }),
    anchors: fakeModel(anchors, { unique: [['_id']] }),
  };
  let published: PublishedFetch = {
    ok: false,
    error: 'HTTP 404',
    nothing: true,
  };
  const fetches: string[] = [];
  const make = () => {
    const service = new AnchorLogService(
      models.leaves as never,
      models.checkpoints as never,
      models.anchors as never,
      { get: (key: string) => env[key] } as never,
      (url) => {
        fetches.push(url);
        return Promise.resolve(published);
      },
    );
    service.trustedRoots = [tsa.root];
    service.now = () => NOW;
    return service;
  };
  const service = make();
  return {
    models,
    service,
    make,
    fetches,
    publish(note: string | PublishedFetch) {
      published = typeof note === 'string' ? { ok: true, note } : note;
      // Once published, the owner removes the bootstrap flag (H1).
      if (published.ok) delete env.ANCHOR_LOG_BOOTSTRAP;
    },
    latestNote() {
      const last = [...models.checkpoints.docs].sort(
        (a, b) => (b._id as number) - (a._id as number),
      )[0];
      return last.note as string;
    },
  };
}

/** Rewrites one cached entry so it still parses and hashes (a careful writer). */
function rewriteEntry(
  docs: Array<Record<string, unknown>>,
  index: number,
  change: (text: string) => string,
) {
  const row = docs.find((doc) => doc._id === index)!;
  row.record = change(row.record as string);
  row.hash = dayRecordHash(row.record as string).toString('hex');
}

describe('AnchorLogService.append', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('appends every finished day once, in day order, and signs the new size', async () => {
    const { service, models, make, publish, latestNote } = setUp();
    const report = await service.append(NOW);
    expect(report).toEqual({
      state: 'appended',
      size: 3,
      appended: 3,
      signed: 3,
      signing: { state: 'signed' },
    });
    const days = models.leaves.docs.map((doc) => [doc._id, doc.day]);
    expect(days).toEqual([
      [0, '2026-11-14'],
      [1, '2026-11-15'],
      [2, '2026-11-16'],
    ]);
    // Only hashes and counts: no ids, no text.
    expect(models.leaves.docs[0].record).toBe(
      formatDayRecord({
        day: '2026-11-14',
        tree: MERKLE_SCHEME,
        root: 'a'.repeat(64),
        leaves: 2,
        leafset: leafSetHash(
          models.anchors.docs.find((d) => d._id === '2026-11-14')!
            .leaves as never,
        ),
        appended: NOW,
      }),
    );
    const [checkpoint] = models.checkpoints.docs;
    expect(checkpoint._id).toBe(3);
    const opened = openNote(
      checkpoint.note as string,
      parseVerifier(KEY.verifierKey),
    );
    expect(opened.ok).toBe(true);
    const body = parseCheckpoint((opened as { text: string }).text)!;
    const hashes = models.leaves.docs.map((doc) =>
      dayRecordHash(doc.record as string),
    );
    expect(body).toEqual({
      origin: ANCHOR_LOG_ORIGIN,
      size: 3,
      root: treeRoot(hashes),
    });
    expect(checkpoint.verifierKey).toBe(KEY.verifierKey);
    // Again: nothing new, nothing re-signed. Still unpublished with the
    // flag on, but this server signed once: the 404 is now "missing"
    // (review round 3, L1).
    expect(await service.append(NOW)).toMatchObject({
      state: 'unchanged',
      size: 3,
      appended: 0,
      signing: { state: 'blocked', reason: 'published-missing' },
    });
    // Published, the flag removed: nothing new, nothing re-signed.
    publish(latestNote());
    expect(await make().append(NOW)).toEqual({
      state: 'unchanged',
      size: 3,
      appended: 0,
      signing: { state: 'unchanged' },
    });
    expect(models.checkpoints.docs).toHaveLength(1);
  });

  it('resumes: a day finished later is appended after the others', async () => {
    const { service, models, make, publish, latestNote } = setUp();
    await service.append(NOW);
    publish(latestNote());
    const building = models.anchors.docs.find((d) => d._id === '2026-11-17')!;
    Object.assign(building, built('2026-11-17', 'c'.repeat(64)));
    expect(await make().append(NOW)).toMatchObject({
      state: 'appended',
      size: 4,
      appended: 1,
      signed: 4,
    });
    expect(models.checkpoints.docs.map((d) => d._id)).toEqual([3, 4]);
  });

  it('leaves out a finished anchor that lost its root, and says so', async () => {
    const { service, models } = setUp(undefined, [
      { ...built('2026-11-14', 'a'.repeat(64)), merkleRoot: undefined },
    ]);
    expect(await service.append(NOW)).toEqual({
      state: 'empty',
      size: 0,
      appended: 0,
    });
    expect(models.leaves.docs).toHaveLength(0);
    expect(Logger.prototype.error).toHaveBeenCalled();
  });

  it('builds the log but signs nothing without a signing key', async () => {
    const { service, models } = setUp({});
    expect(await service.append(NOW)).toEqual({
      state: 'appended',
      size: 3,
      appended: 3,
      note: 'not signed: no signing key on this server',
      signing: { state: 'blocked', reason: 'no-key' },
    });
    expect(models.checkpoints.docs).toHaveLength(0);
    const answer = await service.checkpoint();
    expect(answer).toMatchObject({ signed: false, size: 3 });
    expect((answer as { reasons: string[] }).reasons.join(' ')).toMatch(
      /ANCHOR_LOG_SIGNING_KEY is not set/,
    );
  });

  it('two runs at once write one log: a duplicate entry stops the second', async () => {
    const { make, models } = setUp();
    const [a, b] = [make(), make()];
    const reports = await Promise.all([a.append(NOW), b.append(NOW)]);
    expect(models.leaves.docs.map((d) => d._id)).toEqual([0, 1, 2]);
    expect(new Set(models.leaves.docs.map((d) => d.day)).size).toBe(3);
    expect(reports.map((r) => r.state)).not.toContain('refused');
    expect(models.checkpoints.docs.length).toBeGreaterThanOrEqual(1);
  });

  it('a second signer of the same size and tree is fine; a different tree is a fork', async () => {
    const { service, models, make } = setUp();
    await service.append(NOW);
    // A racer that read the checkpoints before the first one was stored.
    const racer = make();
    jest
      .spyOn(racer as never, 'latestSigned')
      .mockResolvedValue(undefined as never);
    expect((await racer.append(NOW)).signed).toBe(3);
    expect(models.checkpoints.docs).toHaveLength(1);
    // The stored checkpoint of that size has another root: a fork.
    models.checkpoints.docs[0].root = 'f'.repeat(64);
    const forker = make();
    jest
      .spyOn(forker as never, 'latestSigned')
      .mockResolvedValue(undefined as never);
    expect(await forker.append(NOW)).toMatchObject({
      state: 'refused',
      note: 'a different checkpoint of size 3 is stored',
    });
  });

  it('refuses to append or sign once its copy was rewritten under a signed checkpoint', async () => {
    const { service, models, make } = setUp();
    await service.append(NOW);
    rewriteEntry(models.leaves.docs, 1, (t) =>
      t.replace('2026-11-15', '2026-11-18'),
    );
    models.leaves.docs[1].day = '2026-11-18';
    const report = await make().append(NOW);
    expect(report).toMatchObject({ state: 'refused', appended: 0 });
    expect(report.note).toMatch(/signed at size 3/);
    expect(models.checkpoints.docs).toHaveLength(1);
  });

  it('refuses when entries signed for were removed (rolled back)', async () => {
    const { service, models, make } = setUp();
    await service.append(NOW);
    models.leaves.docs.splice(2, 1);
    expect(await make().append(NOW)).toMatchObject({ state: 'refused' });
    // The same process also remembers what it signed.
    expect(await service.append(NOW)).toMatchObject({ state: 'refused' });
  });

  it('refuses a stored checkpoint that does not verify with the log key', async () => {
    const { service, models, make } = setUp();
    await service.append(NOW);
    models.checkpoints.docs[0].note = signNote(
      checkpointText(
        ANCHOR_LOG_ORIGIN,
        3,
        Buffer.from(models.checkpoints.docs[0].root as string, 'hex'),
      ),
      parseSigner(OTHER.privateKey),
    );
    expect(await make().append(NOW)).toMatchObject({
      state: 'refused',
      note: "the stored checkpoint of size 3 does not verify with this log's key",
    });
  });

  it('refuses a copy that disagrees with the PUBLISHED checkpoint, even with no stored one', async () => {
    const { service, models, make, publish, latestNote } = setUp();
    await service.append(NOW);
    publish(latestNote());
    models.checkpoints.docs.length = 0;
    rewriteEntry(models.leaves.docs, 0, (t) =>
      t.replace('a'.repeat(64), 'd'.repeat(64)),
    );
    expect(await make().append(NOW)).toMatchObject({
      state: 'refused',
      note: "this server's copy no longer gives the published checkpoint of size 3",
    });
    publish(signNote('not a checkpoint\n', parseSigner(KEY.privateKey)));
    expect(await make().append(NOW)).toMatchObject({
      state: 'refused',
      note: 'the published checkpoint is not for this log',
    });
  });

  it('refuses a broken copy: a gap, a bad hash, a day twice, a bad record', async () => {
    const cases: Array<(docs: Array<Record<string, unknown>>) => void> = [
      (docs) => (docs[1]._id = 5),
      (docs) => (docs[1].hash = '0'.repeat(64)),
      (docs) => {
        rewriteEntry(docs, 2, (t) => t.replace('2026-11-16', '2026-11-14'));
        docs[2].day = '2026-11-14';
      },
      (docs) => rewriteEntry(docs, 0, () => 'junk'),
      (docs) => (docs[0].day = '2026-11-01'),
    ];
    for (const breakIt of cases) {
      const { service, models, make } = setUp({});
      await service.append(NOW);
      breakIt(models.leaves.docs);
      expect((await make().append(NOW)).state).toBe('refused');
    }
  });

  it('surfaces a failure to write that is not a duplicate', async () => {
    const { service, models } = setUp();
    jest
      .spyOn(models.leaves, 'create')
      .mockRejectedValueOnce(new Error('disk full'));
    await expect(service.append(NOW)).rejects.toThrow('disk full');
    const other = setUp();
    await other.service.append(NOW).catch(() => undefined);
    other.models.checkpoints.docs.length = 0;
    jest
      .spyOn(other.models.checkpoints, 'create')
      .mockRejectedValueOnce(new Error('network'));
    other.models.leaves.docs.length = 0;
    await expect(other.make().append(NOW)).rejects.toThrow('network');
  });
});

describe('AnchorLogService.view (the verifier input)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  async function publishedLog(
    env?: Record<string, string | undefined>,
    anchors?: Array<Record<string, unknown>>,
  ) {
    const s = setUp(env, anchors);
    await s.service.append(NOW);
    if (s.models.checkpoints.docs.length > 0) s.publish(s.latestNote());
    const fresh = () => {
      const v = s.make();
      v.beginCheck();
      return v.view();
    };
    return { ...s, fresh };
  }

  it('passes when the published head is this copy, and places every day', async () => {
    const { fresh, models } = await publishedLog();
    const building = models.anchors.docs.find((d) => d._id === '2026-11-17')!;
    Object.assign(building, built('2026-11-17', 'c'.repeat(64)));
    const view = await fresh();
    expect(view.check.outcome).toBe('pass');
    expect(view.check.detail).toMatch(/3 day\(s\) in the published log/);
    expect(view.day('2026-11-14')).toMatchObject({
      state: 'published',
      index: 0,
    });
    expect(view.day('2026-11-17')).toMatchObject({ state: 'pending' });
    expect(view.day('2099-01-01').state).toBe('cannot-measure');
    const proof = view.proofOf('2026-11-16')!;
    expect(proof).toMatchObject({ index: 2, size: 3 });
    const root = parseCheckpoint(
      (
        openNote(proof.checkpoint, parseVerifier(KEY.verifierKey)) as {
          text: string;
        }
      ).text,
    )!.root;
    expect(
      verifyInclusion(
        2,
        3,
        dayRecordHash(proof.record),
        proof.proof.map((p) => Buffer.from(p, 'base64')),
        root,
      ),
    ).toBe(true);
    expect(view.proofOf('2026-11-17')).toBeUndefined();
  });

  it('a day appended after the published head is pending, never published', async () => {
    const { fresh, models, make } = await publishedLog();
    Object.assign(
      models.anchors.docs.find((d) => d._id === '2026-11-17')!,
      built('2026-11-17', 'c'.repeat(64)),
    );
    await make().append(NOW);
    const view = await fresh();
    expect(view.check.outcome).toBe('pass');
    expect(view.size).toBe(4);
    expect(view.day('2026-11-17')).toMatchObject({ state: 'pending' });
    expect(view.day('2026-11-17').detail).toMatch(/not yet published/);
  });

  describe('fault injection: each fault is caught by the log check alone', () => {
    it('a tampered entry (rehashed, so the copy still reads) FAILS', async () => {
      const { fresh, models } = await publishedLog();
      // The entry and its anchor agree with each other: only the published
      // root can tell.
      rewriteEntry(models.leaves.docs, 0, (t) =>
        t.replace('a'.repeat(64), 'e'.repeat(64)),
      );
      models.anchors.docs.find((d) => d._id === '2026-11-14')!.merkleRoot =
        'e'.repeat(64);
      models.checkpoints.docs.length = 0;
      const view = await fresh();
      expect(view.check.outcome).toBe('fail');
      expect(view.check.detail).toMatch(
        /published checkpoint of size 3: the log was rewritten/,
      );
      expect(view.day('2026-11-16').state).toBe('fail');
    });

    it('a rolled-back size FAILS', async () => {
      const { fresh, models } = await publishedLog();
      models.leaves.docs.splice(2, 1);
      models.checkpoints.docs.length = 0;
      const view = await fresh();
      expect(view.check.outcome).toBe('fail');
      expect(view.check.detail).toMatch(/only 2: entries were removed/);
    });

    it('a forked checkpoint, signed by the right key, FAILS', async () => {
      const { fresh, publish, models } = await publishedLog();
      models.checkpoints.docs.length = 0;
      publish(
        signNote(
          checkpointText(ANCHOR_LOG_ORIGIN, 3, Buffer.alloc(32, 9)),
          parseSigner(KEY.privateKey),
        ),
      );
      const view = await fresh();
      expect(view.check.outcome).toBe('fail');
      expect(view.check.detail).toMatch(/rewritten/);
    });

    it('a checkpoint signed by another key FAILS', async () => {
      const { fresh, publish, latestNote } = await publishedLog();
      const body = (
        openNote(latestNote(), parseVerifier(KEY.verifierKey)) as {
          text: string;
        }
      ).text;
      publish(signNote(body, parseSigner(OTHER.privateKey)));
      expect((await fresh()).check.detail).toMatch(
        /not signed by this log's key/,
      );
      publish(
        latestNote().replace(/ [A-Za-z0-9+/]{20}/, ' AAAAAAAAAAAAAAAAAAAA'),
      );
      const view = await fresh();
      expect(view.check.outcome).toBe('fail');
      publish('garbage');
      expect((await fresh()).check.detail).toMatch(/not a signed note/);
    });

    it('a signature that does not verify FAILS', async () => {
      const { fresh, publish, latestNote } = await publishedLog();
      const note = latestNote();
      const sig = note.trim().split(' ').pop()!;
      const bytes = Buffer.from(sig, 'base64');
      bytes[20] ^= 1;
      publish(note.replace(sig, bytes.toString('base64')));
      expect((await fresh()).check.detail).toMatch(/signature does not verify/);
    });

    it('a stored checkpoint by another key, or one the copy no longer gives, FAILS', async () => {
      const { fresh, models } = await publishedLog();
      const root = models.checkpoints.docs[0].root as string;
      models.checkpoints.docs.push({
        _id: 3,
        root,
        note: signNote(
          checkpointText(ANCHOR_LOG_ORIGIN, 3, Buffer.from(root, 'hex')),
          parseSigner(OTHER.privateKey),
        ),
      });
      models.checkpoints.docs.shift();
      expect((await fresh()).check.detail).toMatch(/does not verify/);
      models.checkpoints.docs[0].note = signNote(
        checkpointText(ANCHOR_LOG_ORIGIN, 4, Buffer.alloc(32, 1)),
        parseSigner(KEY.privateKey),
      );
      models.checkpoints.docs[0]._id = 4;
      models.checkpoints.docs[0].root = Buffer.alloc(32, 1).toString('hex');
      expect((await fresh()).check.detail).toMatch(/signed at size 4/);
    });

    it('a published day whose anchor was DELETED fails every day', async () => {
      const { fresh, models } = await publishedLog();
      models.anchors.docs.splice(
        models.anchors.docs.findIndex((d) => d._id === '2026-11-14'),
        1,
      );
      const view = await fresh();
      expect(view.check.outcome).toBe('fail');
      expect(view.check.detail).toMatch(
        /2026-11-14 is in the published log but missing here/,
      );
      expect(view.day('2026-11-16').state).toBe('fail');
      expect(view.proofOf('2026-11-16')).toBeUndefined();
    });

    it('L3: a published leaf whose version id was rewritten behind the same root FAILS', async () => {
      const { fresh, models } = await publishedLog();
      const anchor = models.anchors.docs.find((d) => d._id === '2026-11-16')!;
      (anchor.leaves as Array<{ versionId: unknown }>)[0].versionId =
        new Types.ObjectId();
      const view = await fresh();
      expect(view.check.outcome).toBe('fail');
      expect(view.check.detail).toMatch(
        /2026-11-16 no longer matches its published log entry/,
      );
    });

    it('a published day whose anchor was re-rooted or relabelled FAILS', async () => {
      for (const change of [
        { merkleRoot: 'f'.repeat(64) },
        { leafCount: 3 },
        { status: 'empty' },
      ]) {
        const { fresh, models } = await publishedLog();
        Object.assign(
          models.anchors.docs.find((d) => d._id === '2026-11-16')!,
          change,
        );
        expect((await fresh()).check.detail).toMatch(
          /2026-11-16 no longer matches its published log entry/,
        );
      }
    });

    it('an anchor planted outside the log FAILS once a later day is published', async () => {
      const { fresh, models, make, publish, latestNote } = await publishedLog();
      // Signed before the 11-20 append that was later published.
      models.anchors.docs.push(
        built(
          '2026-11-10',
          '1'.repeat(64),
          2,
          new Date(NOW.getTime() - 2 * DAY),
        ),
      );
      // Not appended by the server (planted after its run): fail.
      let view = await fresh();
      expect(view.day('2026-11-10')).toMatchObject({ state: 'fail' });
      expect(view.check.outcome).toBe('fail');
      // Signed recently: still pending.
      models.anchors.docs.at(-1)!.tsa = {
        response: tsa.respond('1'.repeat(64), {
          genTime: new Date(NOW.getTime() - LOG_SETTLE_MS + 60_000),
        }),
      };
      view = await fresh();
      expect(view.day('2026-11-10')).toMatchObject({ state: 'pending' });
      expect(view.check.outcome).toBe('pass');
      // No verified time at all: pending, whatever the time.
      models.anchors.docs.at(-1)!.tsa = { response: Buffer.from('junk') };
      expect((await fresh()).day('2026-11-10').state).toBe('pending');
      models.anchors.docs.at(-1)!.tsa = {
        response: tsa.respond('1'.repeat(64), { noToken: true }),
      };
      expect((await fresh()).day('2026-11-10').state).toBe('pending');
      models.anchors.docs.at(-1)!.tsa = {
        response: tsa.respond('2'.repeat(64), {
          genTime: new Date(NOW.getTime() - 2 * DAY),
        }),
      };
      expect((await fresh()).day('2026-11-10').state).toBe('pending');
      void make;
      void publish;
      void latestNote;
    });

    it('an unpublished entry whose anchor changed or vanished FAILS that day', async () => {
      const { fresh, models, make } = await publishedLog();
      Object.assign(
        models.anchors.docs.find((d) => d._id === '2026-11-17')!,
        built('2026-11-17', 'c'.repeat(64)),
      );
      await make().append(NOW);
      models.anchors.docs.find((d) => d._id === '2026-11-17')!.merkleRoot =
        '9'.repeat(64);
      let view = await fresh();
      expect(view.day('2026-11-17')).toMatchObject({ state: 'fail' });
      expect(view.check.outcome).toBe('pass');
      models.anchors.docs.splice(
        models.anchors.docs.findIndex((d) => d._id === '2026-11-17'),
        1,
      );
      view = await fresh();
      expect(view.day('2026-11-17').detail).toMatch(/anchor is missing/);
    });

    it('a broken copy FAILS every day', async () => {
      const { fresh, models } = await publishedLog();
      models.leaves.docs[1].hash = '0'.repeat(64);
      const view = await fresh();
      expect(view.check.outcome).toBe('fail');
      expect(view.day('2026-11-14').state).toBe('fail');
    });
  });

  describe('not set up: cannot measure, never pass', () => {
    it('without a public key', async () => {
      const { fresh } = await publishedLog({
        ANCHOR_LOG_PUBLISHED_URL: 'https://example.org/latest.txt',
      });
      const view = await fresh();
      expect(view.check.outcome).toBe('cannot-measure');
      expect(view.check.detail).toMatch(/No anchor log public key/);
      expect(view.day('2026-11-14').state).toBe('cannot-measure');
      expect(view.day('2026-11-17').state).toBe('pending');
    });

    it('without a published location', async () => {
      const { fresh } = await publishedLog({
        ANCHOR_LOG_SIGNING_KEY: KEY.privateKey,
      });
      const view = await fresh();
      expect(view.check.outcome).toBe('cannot-measure');
      expect(view.check.detail).toMatch(/ANCHOR_LOG_PUBLISHED_URL is not set/);
      expect(view.day('2026-11-14').state).toBe('cannot-measure');
    });

    it('when the published head cannot be read, and when nothing was published', async () => {
      const { fresh, publish } = await publishedLog();
      publish({ ok: false, error: 'HTTP 503' });
      const view = await fresh();
      expect(view.check).toMatchObject({ outcome: 'cannot-measure' });
      expect(view.check.detail).toMatch(/could not be read \(HTTP 503\)/);
      const empty = setUp();
      empty.service.beginCheck();
      expect((await empty.service.view()).check.outcome).toBe('cannot-measure');
    });

    it('with a verifier key only: checks, never signs', async () => {
      const s = setUp({
        ANCHOR_LOG_VERIFIER_KEY: KEY.verifierKey,
        ANCHOR_LOG_PUBLISHED_URL: 'https://example.org/latest.txt',
      });
      expect((await s.service.append(NOW)).signed).toBeUndefined();
      // Published by the real signer elsewhere: this server checks it.
      const hashes = s.models.leaves.docs.map((d) =>
        dayRecordHash(d.record as string),
      );
      s.publish(
        signNote(
          checkpointText(ANCHOR_LOG_ORIGIN, 3, treeRoot(hashes)),
          parseSigner(KEY.privateKey),
        ),
      );
      const checker = s.make();
      checker.beginCheck();
      expect((await checker.view()).check.outcome).toBe('pass');
    });
  });

  it('reads the published head at most every few minutes, and re-reads per check', async () => {
    const { make, fetches } = await publishedLog();
    const service = make();
    fetches.length = 0;
    service.beginCheck();
    await service.view();
    await service.view();
    service.beginCheck();
    await service.view();
    expect(fetches).toHaveLength(1);
    service.now = () => new Date(NOW.getTime() + PUBLISHED_CACHE_MS);
    service.beginCheck();
    await service.view();
    expect(fetches).toHaveLength(2);
  });

  it('forgets a view that failed to compute', async () => {
    const { make, models } = await publishedLog();
    const service = make();
    const find = jest
      .spyOn(models.leaves, 'find')
      .mockImplementationOnce(() => {
        throw new Error('db down');
      });
    service.beginCheck();
    await expect(service.view()).rejects.toThrow('db down');
    find.mockRestore();
    expect((await service.view()).check.outcome).toBe('pass');
  });
});

describe('AnchorLogService: proofs and the checkpoint answer', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('gives inclusion and consistency proofs that verify', async () => {
    const { service, models } = setUp();
    await service.append(NOW);
    Object.assign(
      models.anchors.docs.find((d) => d._id === '2026-11-17')!,
      built('2026-11-17', 'c'.repeat(64)),
    );
    await service.append(NOW);
    const hashes = models.leaves.docs.map((d) =>
      dayRecordHash(d.record as string),
    );
    const inc = await service.inclusion('2026-11-15', 3);
    expect(inc).toMatchObject({ index: 1, size: 3, origin: ANCHOR_LOG_ORIGIN });
    const ok = inc as {
      record: string;
      proof: string[];
      root: string;
      leafHash: string;
    };
    expect(parseDayRecord(ok.record)?.day).toBe('2026-11-15');
    expect(
      verifyInclusion(
        1,
        3,
        Buffer.from(ok.leafHash, 'base64'),
        ok.proof.map((p) => Buffer.from(p, 'base64')),
        Buffer.from(ok.root, 'base64'),
      ),
    ).toBe(true);
    expect(await service.inclusion('2026-11-17')).toMatchObject({
      size: 4,
      index: 3,
    });
    expect(await service.inclusion('2026-11-17', 3)).toEqual({
      error: 'out-of-range',
    });
    expect(await service.inclusion('2026-11-14', 9)).toEqual({
      error: 'out-of-range',
    });
    expect(await service.inclusion('2025-01-01')).toEqual({
      error: 'not-found',
    });
    const con = (await service.consistency(3, 4)) as { proof: string[] };
    expect(
      verifyConsistency(
        3,
        4,
        treeRoot(hashes.slice(0, 3)),
        treeRoot(hashes),
        con.proof.map((p) => Buffer.from(p, 'base64')),
      ),
    ).toBe(true);
    for (const [from, to] of [
      [0, 4],
      [4, 3],
      [1, 5],
    ]) {
      expect(await service.consistency(from, to)).toEqual({
        error: 'out-of-range',
      });
    }
    models.leaves.docs[0].hash = '0'.repeat(64);
    expect(await service.inclusion('2026-11-15')).toEqual({
      error: 'inconsistent',
    });
    expect(await service.consistency(1, 2)).toEqual({ error: 'inconsistent' });
  });

  it('serves the newest signed checkpoint, or says why there is none', async () => {
    const { service, models, make } = setUp();
    expect(await service.checkpoint()).toMatchObject({
      signed: false,
      size: 0,
      reasons: ['no checkpoint has been signed yet'],
    });
    await service.append(NOW);
    const answer = await service.checkpoint();
    expect(answer).toMatchObject({ signed: true, size: 3 });
    models.checkpoints.docs[0].note = 'tampered';
    const tampered = await make().checkpoint();
    expect(tampered).toMatchObject({ signed: false });
    expect((tampered as { reasons: string[] }).reasons.join(' ')).toMatch(
      /does not verify/,
    );
    models.leaves.docs[0].hash = '0'.repeat(64);
    expect(
      ((await make().checkpoint()) as { reasons: string[] }).reasons.join(' '),
    ).toMatch(/this server's copy: entry 0/);
  });

  it('refuses a log too large to prove', async () => {
    const { service, models } = setUp({});
    const find = jest.spyOn(models.leaves, 'find').mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: () => ({
            exec: () => Promise.resolve({ length: 1_000_001 }),
          }),
        }),
      }),
    } as never);
    expect((await service.append(NOW)).note).toBe('too many entries');
    find.mockRestore();
  });

  it('reads the published head over HTTPS, with a status and size check', async () => {
    const s = setUp();
    const real = new AnchorLogService(
      s.models.leaves as never,
      s.models.checkpoints as never,
      s.models.anchors as never,
      { get: () => undefined } as never,
    );
    expect(real.now()).toBeInstanceOf(Date);
    const fetch = jest.spyOn(globalThis, 'fetch');
    fetch.mockResolvedValueOnce(new Response('note\n', { status: 200 }));
    expect(await real.fetchPublished('https://example.org/x')).toEqual({
      ok: true,
      note: 'note\n',
    });
    fetch.mockResolvedValueOnce(new Response('', { status: 404 }));
    // 404: the publication holds nothing yet; any other status: unreadable.
    expect(await real.fetchPublished('https://example.org/x')).toEqual({
      ok: false,
      error: 'HTTP 404',
      nothing: true,
    });
    fetch.mockResolvedValueOnce(new Response('', { status: 503 }));
    expect(await real.fetchPublished('https://example.org/x')).toEqual({
      ok: false,
      error: 'HTTP 503',
    });
    fetch.mockResolvedValueOnce(
      new Response('x'.repeat(20_000), { status: 200 }),
    );
    expect(await real.fetchPublished('https://example.org/x')).toEqual({
      ok: false,
      error: 'too large',
    });
    fetch.mockRejectedValueOnce(new Error('offline'));
    expect(await real.fetchPublished('https://example.org/x')).toEqual({
      ok: false,
      error: 'offline',
    });
    fetch.mockRejectedValueOnce('reset');
    expect(await real.fetchPublished('https://example.org/x')).toEqual({
      ok: false,
      error: 'reset',
    });
  });

  it('with its key removed, still refuses to append past what it signed', async () => {
    const s = setUp();
    await s.service.append();
    s.models.leaves.docs.splice(2, 1);
    const keyless = new AnchorLogService(
      s.models.leaves as never,
      s.models.checkpoints as never,
      s.models.anchors as never,
      { get: () => undefined } as never,
      () => Promise.resolve({ ok: false, error: 'unused' }),
    );
    expect(await keyless.append(NOW)).toMatchObject({ state: 'refused' });
  });
});
