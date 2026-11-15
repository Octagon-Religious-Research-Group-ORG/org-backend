/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion -- wrapping the in-memory fake model queries */
import { Logger } from '@nestjs/common';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { ANCHOR_LOG_ORIGIN } from './anchor-log-config';
import {
  AnchorLogService,
  MAX_ENTRIES_PER_PAGE,
  type PublishedFetch,
} from './anchor-log.service';
import { dayRecordHash } from './day-record';
import { MERKLE_SCHEME } from './merkle';
import { generateNoteKey } from './signed-note';
import { makeTestTsa } from './test-tsa.mocks-spec';

// Chunk 16b review round 2. Each test was written to fail on the code
// before its fix.
const KEY = generateNoteKey(ANCHOR_LOG_ORIGIN);
const NOW = new Date('2026-11-20T04:00:00.000Z');
const tsa = makeTestTsa();
const lf = (n: string) => ({
  kind: 'comment',
  versionId: n.repeat(24),
  versionHash: n.repeat(64),
  leaf: n.repeat(64),
});
const built = (day: string, root: string) => ({
  _id: day,
  status: 'built',
  scheme: MERKLE_SCHEME,
  merkleRoot: root,
  leafCount: 2,
  leaves: [lf('1'), lf('2')],
});
const MISSING: PublishedFetch = { ok: false, error: 'HTTP 404', nothing: true };

export function setUp(env: Record<string, string | undefined>) {
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
  let published: PublishedFetch = MISSING;
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
    set: (p: PublishedFetch) => {
      published = p;
    },
  };
}

const BASE = {
  ANCHOR_LOG_SIGNING_KEY: KEY.privateKey,
  ANCHOR_LOG_PUBLISHED_URL:
    'https://raw.githubusercontent.com/x/y/main/latest.txt',
};
const BOOTSTRAP = { ...BASE, ANCHOR_LOG_BOOTSTRAP: '1' };

/** The reviewer's rewrite: checkpoints gone, entry 0 rewritten consistently. */
function attack(models: ReturnType<typeof setUp>['models']) {
  models.checkpoints.docs.length = 0;
  const row = models.leaves.docs.find((d) => d._id === 0)!;
  row.record = (row.record as string).replace('a'.repeat(64), 'd'.repeat(64));
  row.hash = dayRecordHash(row.record as string).toString('hex');
  models.anchors.docs.find((d) => d._id === '2026-11-14')!.merkleRoot =
    'd'.repeat(64);
  models.anchors.docs.push(built('2026-11-16', 'c'.repeat(64)));
}

describe('H1: a 404 means "nothing published" only while bootstrapping', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('H1 probe B: latest.txt made to 404 after a rewrite => no fork is signed, and it is loud', async () => {
    const boot = setUp(BOOTSTRAP);
    expect((await boot.make().append(NOW)).signed).toBe(2);
    // The owner publishes, then removes the bootstrap flag.
    const { models, set } = boot;
    const note = models.checkpoints.docs[0].note as string;
    const after = setUp(BASE);
    after.models.leaves.docs.push(...models.leaves.docs);
    after.models.checkpoints.docs.push(...models.checkpoints.docs);
    after.models.anchors.docs.length = 0;
    after.models.anchors.docs.push(...models.anchors.docs);
    after.set({ ok: true, note });
    void set;
    attack(after.models);
    after.set(MISSING);
    const report = await after.make().append(NOW);
    expect(report.signed).toBeUndefined();
    expect(report.signing).toEqual({
      state: 'blocked',
      reason: 'published-missing',
    });
    expect(
      after.models.checkpoints.docs.find((d) => d._id === 3),
    ).toBeUndefined();
    const view = await after.make().view();
    expect(view.check).toMatchObject({
      outcome: 'cannot-measure',
      state: 'cannot-measure',
      reason: 'published-missing',
    });
  });

  it('bootstrapping, nothing published yet: the first checkpoint is signed', async () => {
    const { make } = setUp(BOOTSTRAP);
    const report = await make().append(NOW);
    expect(report.signed).toBe(2);
    expect(report.signing).toEqual({ state: 'signed' });
  });

  it('without the flag, a 404 is unreadable: nothing signed, even the first time', async () => {
    const { make, models } = setUp(BASE);
    const report = await make().append(NOW);
    expect(report.signed).toBeUndefined();
    expect(report.signing).toEqual({
      state: 'blocked',
      reason: 'published-missing',
    });
    expect(models.checkpoints.docs).toHaveLength(0);
  });

  it('the flag left on once something is published: nothing signed until it is removed, and said loudly', async () => {
    const { make, models, set } = setUp(BOOTSTRAP);
    await make().append(NOW);
    set({ ok: true, note: models.checkpoints.docs[0].note as string });
    models.anchors.docs.push(built('2026-11-16', 'c'.repeat(64)));
    const report = await make().append(NOW);
    expect(report.signed).toBeUndefined();
    expect(report.signing).toEqual({
      state: 'blocked',
      reason: 'bootstrap-on',
    });
    expect(report.note).toMatch(/remove ANCHOR_LOG_BOOTSTRAP/);
    const view = await make().view();
    expect(view.check).toMatchObject({ reason: 'bootstrap-on' });
  });
});

describe('M2: the leaf lists are audited at most once per interval, never per request', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  /** How many reads of leaf lists the anchors model served. */
  function countLeafReads(models: ReturnType<typeof setUp>['models']) {
    const find = models.anchors.find.bind(models.anchors);
    let reads = 0;
    models.anchors.find = ((filter: unknown) => {
      const query = find(filter as never);
      const select = query.select.bind(query);
      query.select = ((fields: Record<string, unknown>) => {
        if ('leaves.leaf' in fields) reads += 1;
        return select(fields as never);
      }) as typeof query.select;
      return query;
    }) as typeof models.anchors.find;
    return () => reads;
  }

  it('M2: a public burst of checks reads the leaf lists once', async () => {
    const { models, make, set } = setUp(BOOTSTRAP);
    await make().append(NOW);
    set({ ok: true, note: models.checkpoints.docs[0].note as string });
    const service = make();
    const reads = countLeafReads(models);
    const burst = await Promise.all(
      Array.from({ length: 20 }, async () => {
        service.beginCheck();
        return service.view();
      }),
    );
    // All of them got the one shared audit: none read "cannot measure".
    expect(burst.map((view) => view.check.outcome)).toEqual(
      new Array(20).fill('pass'),
    );
    for (let i = 0; i < 20; i++) {
      service.beginCheck();
      expect((await service.view()).check.outcome).toBe('pass');
    }
    expect(reads()).toBe(1);
  });

  it('a stale audit that cannot be refreshed reads as cannot measure, never pass', async () => {
    const { models, make, set } = setUp(BOOTSTRAP);
    await make().append(NOW);
    set({ ok: true, note: models.checkpoints.docs[0].note as string });
    const service = make();
    service.beginCheck();
    expect((await service.view()).check.outcome).toBe('pass');
    // Three hours on, and the audit's own read fails.
    service.now = () => new Date(NOW.getTime() + 3 * 3_600_000);
    const find = models.anchors.find.bind(models.anchors);
    models.anchors.find = ((filter: Record<string, unknown>) => {
      if (filter._id && '$gt' in (filter._id as object)) throw new Error('db');
      return find(filter as never);
    }) as typeof models.anchors.find;
    service.beginCheck();
    expect((await service.view()).check).toMatchObject({
      outcome: 'cannot-measure',
      reason: 'audit-stale',
    });
  });

  it('each anchoring run audits; a list rewritten after it fails at the next audit', async () => {
    const { models, make, set } = setUp(BOOTSTRAP);
    const service = make();
    await service.append(NOW);
    set({ ok: true, note: models.checkpoints.docs[0].note as string });
    service.refreshPublished();
    const reads = countLeafReads(models);
    service.beginCheck();
    expect((await service.view()).auditedAt).toBe(NOW.toISOString());
    expect(reads()).toBe(0);
    (
      models.anchors.docs.find((d) => d._id === '2026-11-14')!.leaves as Array<{
        versionId: string;
      }>
    )[0].versionId = 'f'.repeat(24);
    await service.refreshAudit();
    service.beginCheck();
    expect((await service.view()).check.outcome).toBe('fail');
  });
});

describe('M3: an entries page always fits the publication job answer cap', () => {
  it('M3: at most 100 records a page, and a full page of the widest records stays under half of 64 KiB', async () => {
    expect(MAX_ENTRIES_PER_PAGE).toBe(100);
    const { make } = setUp(BOOTSTRAP);
    const service = make();
    jest.spyOn(service as never, 'cache').mockResolvedValue({
      records: [],
      texts: new Array(101).fill('x'),
      hashes: new Array(101).fill(Buffer.alloc(32)),
    } as never);
    expect(await service.entries(0, 101)).toEqual({ error: 'out-of-range' });
    expect(await service.entries(1, 101)).toMatchObject({ from: 1, to: 101 });
    const widest = `org-anchor-day-v2\nday 2026-11-14\ntree org-anchor-merkle-v99\nroot ${'a'.repeat(64)}\nleaves ${'9'.repeat(16)}\nleafset ${'b'.repeat(64)}\nappended 2026-11-14T03:00:00.000Z\n`;
    const body = JSON.stringify({
      origin: ANCHOR_LOG_ORIGIN,
      from: 999_900,
      to: 1_000_000,
      records: new Array(MAX_ENTRIES_PER_PAGE).fill(widest),
    });
    expect(Buffer.byteLength(body)).toBeLessThan(32 * 1024);
  });
});

describe('M4: re-appending old days into a new (rotated) log is not flagged late', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('M4: the first append of a log takes in its history without the late flag; later late days are flagged', async () => {
    const { models, make } = setUp(BOOTSTRAP);
    models.anchors.docs.push(built('2026-10-01', 'e'.repeat(64)));
    const first = await make().append(NOW);
    expect(first.size).toBe(3);
    expect(first.late).toBeUndefined();
    models.anchors.docs.push(built('2026-10-02', 'f'.repeat(64)));
    expect((await make().append(NOW)).late).toEqual(['2026-10-02']);
  });
});

describe('M2: a failing audit is retried at most once per interval', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('M2: no new attempt within 10 minutes of the last, one after', async () => {
    const { models, make, set } = setUp(BOOTSTRAP);
    const service = make();
    await service.append(NOW);
    set({ ok: true, note: models.checkpoints.docs[0].note as string });
    service.refreshPublished();
    const find = models.anchors.find.bind(models.anchors);
    let attempts = 0;
    models.anchors.find = ((filter: Record<string, unknown>) => {
      if (filter._id && '$gt' in (filter._id as object)) {
        attempts += 1;
        throw new Error('db');
      }
      return find(filter as never);
    }) as typeof models.anchors.find;
    const at = (minutes: number) => () =>
      new Date(NOW.getTime() + 3 * 3_600_000 + minutes * 60_000);
    for (const [minutes, expected] of [
      [0, 1],
      [5, 1],
      [9, 1],
      [11, 2],
    ] as const) {
      service.now = at(minutes);
      service.refreshPublished();
      service.beginCheck();
      expect((await service.view()).check.outcome).toBe('cannot-measure');
      expect(attempts).toBe(expected);
    }
  });
});

describe('M2: the audit reads in bounded batches, and one at a time', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('covers more anchors than one batch, and a second call while one runs shares it', async () => {
    const { models, make } = setUp(BOOTSTRAP);
    for (let i = 1; i <= 25; i++) {
      models.anchors.docs.push(
        built(
          `2026-10-${String(i).padStart(2, '0')}`,
          String(i % 10).repeat(64),
        ),
      );
    }
    const service = make();
    const [a, b] = [service.refreshAudit(), service.refreshAudit()];
    expect(a).toBe(b);
    const audit = await a;
    expect(audit?.sets.size).toBe(27);
  });

  it('without a key there is no audit, and the health summary carries no audit time', async () => {
    const { make } = setUp({
      ANCHOR_LOG_PUBLISHED_URL:
        'https://raw.githubusercontent.com/x/y/main/latest.txt',
    });
    const view = await make().view();
    expect(view.auditedAt).toBeUndefined();
    expect(view.check).toMatchObject({ reason: 'no-key' });
  });
});
