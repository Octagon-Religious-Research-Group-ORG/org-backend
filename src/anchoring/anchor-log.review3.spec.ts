import { Logger } from '@nestjs/common';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { ANCHOR_LOG_ORIGIN } from './anchor-log-config';
import { AnchorLogService, type PublishedFetch } from './anchor-log.service';
import { parseDayRecord, recordOfAnchor } from './day-record';
import { MERKLE_SCHEME } from './merkle';
import { generateNoteKey } from './signed-note';
import { makeTestTsa } from './test-tsa.mocks-spec';

// Chunk 16b review round 3. Each test was written to fail on the code
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
const built = (day: string, root: string, scheme = MERKLE_SCHEME) => ({
  _id: day,
  status: 'built',
  scheme,
  merkleRoot: root,
  leafCount: 2,
  leaves: [lf('1'), lf('2')],
});
const MISSING: PublishedFetch = { ok: false, error: 'HTTP 404', nothing: true };
const BOOTSTRAP = {
  ANCHOR_LOG_SIGNING_KEY: KEY.privateKey,
  ANCHOR_LOG_PUBLISHED_URL:
    'https://raw.githubusercontent.com/x/y/main/latest.txt',
  ANCHOR_LOG_BOOTSTRAP: '1',
};

function setUp(env: Record<string, string | undefined> = BOOTSTRAP) {
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

describe('L1 (review 3): the bootstrap flag accepts a 404 only before this server first signed', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('flag still on, a stored checkpoint, the publication 404s: nothing new is signed, and it is loud', async () => {
    const { models, make } = setUp();
    expect((await make().append(NOW)).signed).toBe(2);
    models.anchors.docs.push(built('2026-11-16', 'c'.repeat(64)));
    const report = await make().append(NOW);
    expect(report.signed).toBeUndefined();
    expect(report.signing).toEqual({
      state: 'blocked',
      reason: 'published-missing',
    });
    expect(report.note).toContain('ANCHOR_LOG_BOOTSTRAP');
    expect(models.checkpoints.docs.map((d) => d._id)).toEqual([2]);
    const view = await make().view();
    expect(view.check).toMatchObject({
      state: 'cannot-measure',
      reason: 'published-missing',
    });
  });

  it('the same in one process whose stored checkpoints were wiped (it remembers signing)', async () => {
    const { models, make } = setUp();
    const service = make();
    expect((await service.append(NOW)).signed).toBe(2);
    models.checkpoints.docs.length = 0;
    models.anchors.docs.push(built('2026-11-16', 'c'.repeat(64)));
    const report = await service.append(NOW);
    expect(report.signing).toEqual({
      state: 'blocked',
      reason: 'published-missing',
    });
    expect(models.checkpoints.docs).toHaveLength(0);
  });

  it('the residual, stated: with the flag on and NO checkpoint stored anywhere, a 404 still signs (a first deployment)', async () => {
    const { models, make } = setUp();
    expect((await make().append(NOW)).signed).toBe(2);
    expect(models.checkpoints.docs).toHaveLength(1);
  });

  it('the view says the flag is on, whatever else it says', async () => {
    const boot = setUp();
    expect((await boot.make().view()).bootstrap).toBe(true);
    await boot.make().append(NOW);
    expect((await boot.make().view()).bootstrap).toBe(true);
    const off = setUp({ ...BOOTSTRAP, ANCHOR_LOG_BOOTSTRAP: undefined });
    expect((await off.make().view()).bootstrap).toBe(false);
  });
});

describe('L4 (review 3): an anchor scheme is bounded', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('a scheme out of bounds is never recorded, and the audit calls the anchor unreadable', async () => {
    const long = `org-anchor-merkle-v2${'9'.repeat(70_000)}`;
    for (const scheme of [long, 'org-anchor-merkle-v1000', 'other', '']) {
      expect(
        recordOfAnchor(
          built('2026-11-16', 'c'.repeat(64), scheme) as never,
          NOW,
        ),
      ).toBeUndefined();
    }
    expect(
      recordOfAnchor(
        built('2026-11-16', 'c'.repeat(64), 'org-anchor-merkle-v999') as never,
        NOW,
      ),
    ).toBeDefined();
    const { models, make } = setUp();
    models.anchors.docs.push(built('2026-11-16', 'c'.repeat(64), long));
    const service = make();
    const report = await service.append(NOW);
    expect(report.size).toBe(2);
    const audit = await service.refreshAudit();
    expect(audit!.sets.get('2026-11-16')).toBe('unreadable');
  });

  it('a root that is not 64 hex digits is never recorded either', () => {
    expect(
      recordOfAnchor(built('2026-11-16', 'x') as never, NOW),
    ).toBeUndefined();
  });

  it('the parser takes at most three digits of scheme version', () => {
    const text = (tree: string) =>
      `org-anchor-day-v2\nday 2026-11-14\ntree ${tree}\nroot ${'a'.repeat(64)}\nleaves 2\nleafset ${'b'.repeat(64)}\nappended 2026-11-14T04:00:00.000Z\n`;
    expect(parseDayRecord(text('org-anchor-merkle-v999'))).toBeDefined();
    expect(parseDayRecord(text('org-anchor-merkle-v1000'))).toBeUndefined();
  });
});
