import { Logger } from '@nestjs/common';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { ANCHOR_LOG_ORIGIN } from './anchor-log-config';
import { AnchorLogService, type PublishedFetch } from './anchor-log.service';
import { dayRecordHash } from './day-record';
import { MERKLE_SCHEME } from './merkle';
import { generateNoteKey } from './signed-note';
import { makeTestTsa } from './test-tsa.mocks-spec';

// Chunk 16b review round 1. Each test was written to fail on the code
// before its fix.
const KEY = generateNoteKey(ANCHOR_LOG_ORIGIN);
const NOW = new Date('2026-11-20T04:00:00.000Z');
const DAY = 86_400_000;
const tsa = makeTestTsa();
const built = (day: string, root: string) => ({
  _id: day,
  status: 'built',
  scheme: MERKLE_SCHEME,
  merkleRoot: root,
  leafCount: 2,
  leaves: [1, 2].map((i) => ({
    kind: 'block',
    versionId: `65000000000000000000000${i}`,
    versionHash: String(i).repeat(64),
    leaf: String(i + 2).repeat(64),
  })),
});

function setUp(env: Record<string, string | undefined>) {
  const models = {
    leaves: fakeModel([], { unique: [['_id'], ['day']] }),
    checkpoints: fakeModel([], { unique: [['_id']] }),
    anchors: fakeModel(
      [
        built('2026-11-14', 'a'.repeat(64)),
        built('2026-11-15', 'b'.repeat(64)),
      ],
      { unique: [['_id']] },
    ),
  };
  let published: PublishedFetch = {
    ok: false,
    error: 'HTTP 404',
    nothing: true,
  };
  const make = () => {
    const service = new AnchorLogService(
      models.leaves as never,
      models.checkpoints as never,
      models.anchors as never,
      { get: (key: string) => env[key] } as never,
      () => Promise.resolve(published),
    );
    service.trustedRoots = [tsa.root];
    service.now = () => NOW;
    return service;
  };
  return {
    models,
    make,
    publish: (p: PublishedFetch) => {
      published = p;
    },
  };
}

const FULL = {
  ANCHOR_LOG_SIGNING_KEY: KEY.privateKey,
  ANCHOR_LOG_PUBLISHED_URL: 'https://example.org/latest.txt',
  // Until the first publication only (review 2, H1).
  ANCHOR_LOG_BOOTSTRAP: '1',
};

describe('M1: never sign while the published head is unreadable', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('M1 probe: writer + restart + a 503 from the published copy => no fork is signed', async () => {
    const { models, make, publish } = setUp(FULL);
    expect((await make().append(NOW)).signed).toBe(2);
    publish({ ok: true, note: models.checkpoints.docs[0].note as string });
    // The writer deletes the checkpoints and rewrites entry 0 consistently;
    // the server restarts; the published copy answers 503 once.
    models.checkpoints.docs.length = 0;
    const row = models.leaves.docs.find((d) => d._id === 0)!;
    row.record = (row.record as string).replace('a'.repeat(64), 'd'.repeat(64));
    row.hash = dayRecordHash(row.record as string).toString('hex');
    models.anchors.docs.find((d) => d._id === '2026-11-14')!.merkleRoot =
      'd'.repeat(64);
    models.anchors.docs.push(built('2026-11-16', 'c'.repeat(64)));
    publish({ ok: false, error: 'HTTP 503' });
    const report = await make().append(new Date(NOW.getTime() + DAY));
    expect(report.signed).toBeUndefined();
    expect(report.note).toMatch(
      /not signed: the published head could not be read \(HTTP 503\)/,
    );
    expect(models.checkpoints.docs.find((d) => d._id === 3)).toBeUndefined();
    // It still appends: the log keeps growing, unsigned.
    expect(report).toMatchObject({ state: 'appended', size: 3 });
  });

  it('nothing published yet (the copy answers 404): the first checkpoint is signed', async () => {
    const { make } = setUp(FULL);
    expect((await make().append(NOW)).signed).toBe(2);
  });

  it('a key but no published location: never signs, and says why', async () => {
    const { make, models } = setUp({ ANCHOR_LOG_SIGNING_KEY: KEY.privateKey });
    const report = await make().append(NOW);
    expect(report.signed).toBeUndefined();
    expect(report.note).toMatch(/ANCHOR_LOG_PUBLISHED_URL is not set/);
    expect(models.checkpoints.docs).toHaveLength(0);
  });
});

describe('L2: a day appended long after its date is flagged, not failed', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('L2: the append reports it, and the view says so on a published day', async () => {
    const env: Record<string, string | undefined> = { ...FULL };
    const { models, make, publish } = setUp(env);
    // An unused, valid, OLD day id: the server appends it like any other
    // (the log proves append order and time, not the day's activity). Not
    // the log's first append, whose history is late by construction (M4).
    await make().append(NOW);
    // Published, and the owner removed the flag (review round 3, L1).
    publish({ ok: true, note: models.checkpoints.docs[0].note as string });
    delete env.ANCHOR_LOG_BOOTSTRAP;
    models.anchors.docs.push(built('2026-11-01', 'e'.repeat(64)));
    const report = await make().append(NOW);
    expect(report.late).toEqual(['2026-11-01']);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- a jest spy
    expect(Logger.prototype.warn).toHaveBeenCalled();
    publish({
      ok: true,
      note: models.checkpoints.docs.find((d) => d._id === 3)!.note as string,
    });
    const view = await make().view();
    expect(view.check.outcome).toBe('pass');
    expect(view.day('2026-11-01')).toMatchObject({ state: 'published' });
    expect(view.day('2026-11-01').detail).toMatch(
      /appended 19 days after its day/,
    );
    expect(view.day('2026-11-15').detail).not.toMatch(/after its day/);
  });
});

describe('M2c: a rotated log signs and checks under its own origin', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('M2c: v2 checkpoints, proofs and checks all name v2', async () => {
    const V2 = 'orgspirituality.org/anchors/v2';
    const key2 = generateNoteKey(V2);
    const { models, make, publish } = setUp({
      ANCHOR_LOG_ORIGIN: V2,
      ANCHOR_LOG_SIGNING_KEY: key2.privateKey,
      ANCHOR_LOG_PUBLISHED_URL: 'https://example.org/v2/latest.txt',
      ANCHOR_LOG_BOOTSTRAP: '1',
    });
    const service = make();
    expect((await service.append(NOW)).signed).toBe(2);
    const note = models.checkpoints.docs[0].note as string;
    expect(note.startsWith(`${V2}\n2\n`)).toBe(true);
    expect(await service.consistency(1, 2)).toMatchObject({ origin: V2 });
    publish({ ok: true, note });
    const view = await make().view();
    expect(view.check.outcome).toBe('pass');
  });
});

describe('M2a: the entries themselves are public, so a copy can rebuild the log', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('M2a: gives the records of a range, in order, and refuses ranges outside the log', async () => {
    const { models, make } = setUp(FULL);
    const service = make();
    await service.append(NOW);
    const answer = await service.entries(0, 2);
    expect(answer).toEqual({
      origin: ANCHOR_LOG_ORIGIN,
      from: 0,
      to: 2,
      records: models.leaves.docs.map((d) => d.record),
    });
    expect(await service.entries(1, 2)).toMatchObject({
      records: [models.leaves.docs[1].record],
    });
    for (const [from, to] of [
      [2, 1],
      [0, 3],
      [-1, 1],
    ]) {
      expect(await service.entries(from, to)).toEqual({
        error: 'out-of-range',
      });
    }
    jest.spyOn(service as never, 'cache').mockResolvedValueOnce({
      records: [],
      texts: new Array(1001).fill('x'),
      hashes: new Array(1001).fill(Buffer.alloc(32)),
    } as never);
    expect(await service.entries(0, 1001)).toEqual({ error: 'out-of-range' });
    models.leaves.docs[0].hash = '0'.repeat(64);
    expect(await service.entries(0, 1)).toEqual({ error: 'inconsistent' });
  });
});

describe('L3: an anchor that vanishes between the listing and its leaves', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('is left out (no leaf list, no record), never appended without its leaves', async () => {
    const { models, make } = setUp(FULL);
    const service = make();
    // The listing read it (a real projection holds no leaves; the fake
    // returns whole rows, so its leaves are taken off here), then it is gone.
    delete models.anchors.docs.find((d) => d._id === '2026-11-15')!.leaves;
    const original = models.anchors.findOne;
    const findOne = (filter: Record<string, unknown>) =>
      original(filter._id === '2026-11-15' ? { _id: 'gone' } : filter);
    models.anchors.findOne = findOne;
    const report = await service.append(NOW);
    expect(report).toMatchObject({ size: 1, appended: 1 });
    expect(models.leaves.docs.map((d) => d.day)).toEqual(['2026-11-14']);
  });
});
