/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- in-memory fake rows */
import { Logger } from '@nestjs/common';
import {
  addBlockVersion,
  addCommentVersion,
  anchorModels,
  type AnchorModels,
} from './anchoring-harness.mocks-spec';
import {
  anchorDay,
  AnchoringService,
  BUILD_LEASE_MS,
  MAX_RETRY_DELAY_MS,
  retryDelay,
  SETTLE_MS,
  UPGRADE_INTERVAL_MS,
} from './anchoring.service';
import { buildTree, leafHash } from './merkle';
import { parseDetached, parseTimestamp, summarize } from './ots';
import type { CalendarAnswer } from './providers';
import {
  CALENDAR_RESPONSES,
  FREETSA_RESPONSE,
} from './step0-fixtures.mocks-spec';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-14T04:00:00Z');
const later = (ms: number, from = NOW) => new Date(from.getTime() + ms);

/** The real Step 0 calendar answers, replayed for any root. */
function calendarsAnswer(
  root: string,
  ok = [true, true, true, true],
): CalendarAnswer[] {
  return Object.entries(CALENDAR_RESPONSES).map(([url, body], i) =>
    ok[i]
      ? { url, ok: true, tree: parseTimestamp(body, Buffer.from(root, 'hex')) }
      : { url, ok: false, error: 'HTTP 503' },
  );
}

/** A Bitcoin subtree for a commitment (synthetic block height). */
function bitcoinTree(commitment: string) {
  return parseTimestamp(
    Buffer.concat([
      Buffer.from([0x08, 0x00]),
      Buffer.from('0588960d73d71901', 'hex'),
      Buffer.from([0x03, 0xeb, 0x8d, 0x35]),
    ]),
    Buffer.from(commitment, 'hex'),
  );
}

describe('AnchoringService', () => {
  let m: AnchorModels;
  let service: AnchoringService;
  const settings = { enabled: true, hourUtc: 3 };
  const tsa = { settings, timestamp: jest.fn() };
  const ots = { settings, submit: jest.fn(), upgrade: jest.fn() };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    m = anchorModels();
    tsa.timestamp.mockReset().mockResolvedValue({
      response: FREETSA_RESPONSE,
      tst: { genTime: new Date('2026-11-14T04:00:01Z'), serial: '0a01' },
    });
    ots.submit
      .mockReset()
      .mockImplementation((root: string) =>
        Promise.resolve(calendarsAnswer(root)),
      );
    ots.upgrade.mockReset().mockResolvedValue({ state: 'pending' });
    service = new AnchoringService(
      m.anchors as never,
      m.leaves as never,
      m.blocks as never,
      m.comments as never,
      tsa as never,
      ots as never,
    );
    service.retryPauseMs = 0;
  });

  afterEach(() => jest.restoreAllMocks());

  const anchor = (id = anchorDay(NOW)) =>
    m.anchors.docs.find((doc) => doc._id === id) as Record<string, any>;

  it('names an anchor by its UTC date and backs off from 1 h to at most a day', () => {
    expect(anchorDay(new Date('2026-11-14T23:59:59Z'))).toBe('2026-11-14');
    expect([1, 2, 3, 0].map(retryDelay)).toEqual([
      HOUR,
      2 * HOUR,
      4 * HOUR,
      HOUR,
    ]);
    expect(retryDelay(20)).toBe(MAX_RETRY_DELAY_MS);
    expect(service.enabled).toBe(true);
  });

  it('does nothing before the hour, and nothing when there is nothing new', async () => {
    addBlockVersion(m);
    expect((await service.run(new Date('2026-11-14T02:59:00Z'))).build).toEqual(
      {
        state: 'not-due',
      },
    );
    const empty = anchorModels();
    const idle = new AnchoringService(
      empty.anchors as never,
      empty.leaves as never,
      empty.blocks as never,
      empty.comments as never,
      tsa as never,
      ots as never,
    );
    expect(await idle.run(NOW)).toEqual({
      resumed: [],
      build: { state: 'nothing-new' },
      tsa: [],
      ots: [],
    });
    // Without a time it uses the clock.
    expect((await idle.run()).tsa).toEqual([]);
    expect(empty.anchors.docs).toHaveLength(0);
    expect(tsa.timestamp).not.toHaveBeenCalled();
    expect(ots.submit).not.toHaveBeenCalled();
  });

  it('anchors belief AND comment versions in one tree, and gets both proofs for its root', async () => {
    const b = addBlockVersion(m);
    const c = addCommentVersion(m);
    const report = await service.run(NOW);
    expect(report.build).toEqual({
      state: 'built',
      anchorId: '2026-11-14',
      leaves: 2,
    });
    const row = anchor();
    const root = buildTree(
      m.leaves.docs.map((d) =>
        leafHash(d.versionHash as string, d.salt as string),
      ),
    ).root;
    expect(row).toMatchObject({
      status: 'built',
      scheme: 'org-anchor-merkle-v2',
      merkleRoot: root,
      cutoff: later(-SETTLE_MS),
    });
    expect(row.leaves.map((l: any) => l.kind).sort()).toEqual([
      'block',
      'comment',
    ]);
    expect(m.leaves.docs.map((d) => d._id).sort()).toEqual(
      [`b:${String(b._id)}`, `c:${String(c._id)}`].sort(),
    );
    // Only the root leaves the server, to both providers.
    expect(tsa.timestamp).toHaveBeenCalledWith(root, 0);
    expect(ots.submit).toHaveBeenCalledWith(root, 0);
    expect(report.tsa).toEqual([
      { anchorId: '2026-11-14', outcome: 'granted' },
    ]);
    expect(report.ots).toEqual([
      { anchorId: '2026-11-14', outcome: 'pending' },
    ]);
    expect(row.tsa).toMatchObject({
      status: 'granted',
      attempts: 1,
      serial: '0a01',
    });
    expect(Buffer.isBuffer(row.tsa.response)).toBe(true);
    const proof = parseDetached(row.ots.proof);
    expect(proof.digest.toString('hex')).toBe(root);
    expect(summarize(proof.tree).pending).toHaveLength(4);
    expect(row.ots).toMatchObject({
      status: 'pending',
      nextAttemptAt: later(UPGRADE_INTERVAL_MS),
    });
    expect(row.lease).toBeUndefined();
    expect(row.tsa.lease).toBeUndefined();
  });

  it('a version made after the cutoff, or the next day, goes in the next anchor only', async () => {
    const first = addBlockVersion(m);
    const settling = addBlockVersion(m, { createdAt: later(-SETTLE_MS / 2) });
    await service.run(NOW);
    expect(anchor().leaves).toHaveLength(1);
    // Same day: one anchor a day, whoever asks.
    addCommentVersion(m, { createdAt: later(HOUR) });
    expect((await service.run(later(2 * HOUR))).build).toEqual({
      state: 'already-built',
      anchorId: '2026-11-14',
    });
    expect((await service.build(later(3 * HOUR), true)).state).toBe(
      'already-built',
    );
    const next = later(24 * HOUR);
    const report = await service.run(next);
    expect(report.build).toEqual({
      state: 'built',
      anchorId: '2026-11-15',
      leaves: 2,
    });
    const ids = anchor('2026-11-15').leaves.map((l: any) =>
      String(l.versionId),
    );
    expect(ids).toContain(String(settling._id));
    expect(ids).not.toContain(String(first._id));
    // Never twice: one claim per version.
    expect(m.leaves.docs).toHaveLength(3);
  });

  it('force makes the day’s anchor before the hour', async () => {
    addBlockVersion(m);
    expect(
      (await service.run(new Date('2026-11-14T01:00:00Z'), true)).build.state,
    ).toBe('built');
  });

  it('a second instance finding a live build steps aside; a dead one is taken over', async () => {
    addBlockVersion(m);
    await m.anchors.create({
      _id: '2026-11-14',
      status: 'building',
      lease: { id: 'other', until: later(BUILD_LEASE_MS) },
      cutoff: later(-SETTLE_MS),
    });
    expect((await service.build(NOW)).state).toBe('busy');
    const report = await service.build(later(BUILD_LEASE_MS + 1));
    expect(report).toEqual({
      state: 'built',
      anchorId: '2026-11-14',
      leaves: 1,
    });
  });

  it('two instances creating the same day: the second is told busy', async () => {
    addBlockVersion(m);
    const create = m.anchors.create;
    m.anchors.create = async (doc) => {
      await create({ ...doc, lease: { id: 'winner', until: later(HOUR) } });
      return create(doc);
    };
    expect((await service.build(NOW)).state).toBe('busy');
    expect(m.anchors.docs).toHaveLength(1);
  });

  it('rethrows a write error that is not a duplicate', async () => {
    addBlockVersion(m);
    m.anchors.create = () => Promise.reject(new Error('disk full'));
    await expect(service.build(NOW)).rejects.toThrow('disk full');
  });

  it('a version claimed meanwhile by another batch is not ours, and nothing is lost', async () => {
    const a = addBlockVersion(m);
    const b = addBlockVersion(m);
    const insert = m.leaves.insertMany;
    m.leaves.insertMany = async (docs, options) => {
      // Another day's builder claims `a` between our read and our insert.
      await m.leaves.create({ ...docs[0], anchorId: '2026-11-13' });
      return insert(docs, options);
    };
    const built = await service.build(NOW);
    expect(built).toEqual({
      state: 'built',
      anchorId: '2026-11-14',
      leaves: 1,
    });
    expect(anchor().leaves.map((l: any) => String(l.versionId))).toEqual([
      String(b._id),
    ]);
    expect(
      m.leaves.docs.find((d) => d._id === `b:${String(a._id)}`)?.anchorId,
    ).toBe('2026-11-13');
  });

  it('any other insert error stops the build', async () => {
    addBlockVersion(m);
    m.leaves.insertMany = () =>
      Promise.reject(
        Object.assign(new Error('mixed'), { writeErrors: [{ code: 2 }] }),
      );
    await expect(service.build(NOW)).rejects.toThrow('mixed');
    m.leaves.insertMany = () => Promise.reject(new Error('network'));
    await expect(service.build(later(BUILD_LEASE_MS + 1))).rejects.toThrow(
      'network',
    );
  });

  it('reads a duplicate reported in the driver’s nested form too', async () => {
    const v = addBlockVersion(m);
    m.leaves.insertMany = async (docs) => {
      await m.leaves.create(docs[0]);
      throw Object.assign(new Error('E11000'), {
        writeErrors: [{ err: { code: 11000 } }],
      });
    };
    expect(await service.build(NOW)).toEqual({
      state: 'built',
      anchorId: '2026-11-14',
      leaves: 1,
    });
    expect(String(anchor().leaves[0].versionId)).toBe(String(v._id));
  });

  it('a takeover whose versions were all claimed elsewhere is recorded as empty', async () => {
    const v = addBlockVersion(m);
    await m.leaves.create({
      _id: `b:${String(v._id)}`,
      anchorId: '2026-11-13',
      kind: 'block',
      versionId: v._id,
      versionHash: v.hash,
      versionCreatedAt: v.createdAt,
    });
    await m.anchors.create({
      _id: '2026-11-14',
      status: 'building',
      lease: { id: 'dead', until: later(-1) },
      cutoff: later(-SETTLE_MS),
    });
    expect(await service.build(NOW)).toEqual({
      state: 'empty',
      anchorId: '2026-11-14',
    });
    expect(anchor().status).toBe('empty');
    expect(await service.build(later(HOUR))).toEqual({
      state: 'empty',
      anchorId: '2026-11-14',
    });
  });

  it('a builder that lost its lease writes nothing', async () => {
    addBlockVersion(m);
    const update = m.anchors.updateOne;
    m.anchors.updateOne = (filter, change) => {
      const row = m.anchors.docs[0] as Record<string, any>;
      if (row?.status === 'building')
        row.lease = { id: 'thief', until: later(HOUR) };
      return update(filter, change);
    };
    expect(await service.build(NOW)).toEqual({ state: 'busy' });
    expect(anchor().status).toBe('building');
  });

  it('…and on the empty path too', async () => {
    await m.anchors.create({
      _id: '2026-11-14',
      status: 'building',
      lease: { id: 'dead', until: later(-1) },
      cutoff: later(-SETTLE_MS),
    });
    const update = m.anchors.updateOne;
    m.anchors.updateOne = (filter, change) => {
      (m.anchors.docs[0] as Record<string, any>).lease = {
        id: 'thief',
        until: later(HOUR),
      };
      return update(filter, change);
    };
    expect(await service.build(NOW)).toEqual({ state: 'busy' });
  });

  describe('FreeTSA', () => {
    beforeEach(() => addBlockVersion(m));

    it('a failure is recorded, retried after its back-off, and then granted', async () => {
      tsa.timestamp.mockRejectedValueOnce(new Error('HTTP 503'));
      expect((await service.run(NOW)).tsa).toEqual([
        { anchorId: '2026-11-14', outcome: 'failed' },
      ]);
      expect(anchor().tsa).toMatchObject({
        status: 'failed',
        attempts: 1,
        lastError: 'HTTP 503',
        nextAttemptAt: later(HOUR),
      });
      // The other provider is not held up.
      expect(anchor().ots.status).toBe('pending');
      expect((await service.run(later(HOUR / 2))).tsa).toEqual([]);
      expect((await service.run(later(HOUR))).tsa).toEqual([
        { anchorId: '2026-11-14', outcome: 'granted' },
      ]);
      expect(anchor().tsa).toMatchObject({
        status: 'granted',
        attempts: 2,
        lastError: null,
        nextAttemptAt: null,
      });
      expect(tsa.timestamp).toHaveBeenCalledTimes(2);
    });

    it('records a thrown non-Error too', async () => {
      tsa.timestamp.mockRejectedValueOnce('socket hang up');
      await service.run(NOW);
      expect(anchor().tsa.lastError).toBe('socket hang up');
    });

    it('a step held by another instance is left alone', async () => {
      await service.build(NOW);
      anchor().tsa.lease = { id: 'other', until: later(HOUR) };
      anchor().ots.lease = { id: 'other', until: later(HOUR) };
      const report = await service.run(NOW);
      expect(report.tsa).toEqual([{ anchorId: '2026-11-14', outcome: 'busy' }]);
      expect(report.ots).toEqual([{ anchorId: '2026-11-14', outcome: 'busy' }]);
      expect(tsa.timestamp).not.toHaveBeenCalled();
    });

    it('a result whose lease was lost is not written', async () => {
      await service.build(NOW);
      tsa.timestamp.mockImplementationOnce(() => {
        anchor().tsa.lease.id = 'thief';
        return Promise.resolve({
          response: FREETSA_RESPONSE,
          tst: { genTime: NOW, serial: '01' },
        });
      });
      expect((await service.run(NOW)).tsa).toEqual([
        { anchorId: '2026-11-14', outcome: 'lease-lost' },
      ]);
      expect(anchor().tsa.status).toBe('pending');
    });
  });

  describe('OpenTimestamps', () => {
    beforeEach(() => addBlockVersion(m));

    it('no calendar answering is a failure, retried later', async () => {
      ots.submit.mockImplementationOnce((root: string) =>
        Promise.resolve(calendarsAnswer(root, [false, false, false, false])),
      );
      expect((await service.run(NOW)).ots).toEqual([
        { anchorId: '2026-11-14', outcome: 'failed' },
      ]);
      expect(anchor().ots).toMatchObject({
        status: 'failed',
        attempts: 1,
        nextAttemptAt: later(HOUR),
        lastError: 'no calendar accepted the root',
      });
      expect(anchor().ots.calendars).toHaveLength(4);
      // FreeTSA is not held up by it.
      expect(anchor().tsa.status).toBe('granted');
      await service.run(later(HOUR));
      expect(anchor().ots.status).toBe('pending');
      expect(anchor().ots.attempts).toBe(2);
    });

    it('one calendar answering is enough; the others are recorded as down', async () => {
      ots.submit.mockImplementationOnce((root: string) =>
        Promise.resolve(calendarsAnswer(root, [false, true, false, false])),
      );
      await service.run(NOW);
      expect(anchor().ots.status).toBe('pending');
      expect(anchor().ots.calendars.map((c: any) => c.ok)).toEqual([
        false,
        true,
        false,
        false,
      ]);
      expect(anchor().ots.calendars[0]).toEqual({
        url: 'https://a.pool.opentimestamps.org',
        ok: false,
        error: 'HTTP 503',
      });
      expect(
        summarize(parseDetached(anchor().ots.proof).tree).pending,
      ).toHaveLength(1);
    });

    it('a pending proof is asked about every 6 h until Bitcoin has it, then never again', async () => {
      await service.run(NOW);
      expect((await service.run(later(HOUR))).ots).toEqual([]);
      const firstAsk = later(UPGRADE_INTERVAL_MS);
      expect((await service.run(firstAsk)).ots).toEqual([
        { anchorId: '2026-11-14', outcome: 'pending' },
      ]);
      expect(ots.upgrade).toHaveBeenCalledTimes(4);
      expect(anchor().ots).toMatchObject({
        status: 'pending',
        lastUpgradeAt: firstAsk,
        nextAttemptAt: later(UPGRADE_INTERVAL_MS, firstAsk),
        lastError: null,
      });

      ots.upgrade.mockReset();
      ots.upgrade
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({
          state: 'refused',
          reason: 'calendar not on the allowed list',
        })
        .mockImplementationOnce((_uri: string, commitment: string) =>
          Promise.resolve({ state: 'upgraded', tree: bitcoinTree(commitment) }),
        );
      const secondAsk = later(UPGRADE_INTERVAL_MS, firstAsk);
      expect((await service.run(secondAsk)).ots).toEqual([
        { anchorId: '2026-11-14', outcome: 'confirmed' },
      ]);
      // Stopped at the first Bitcoin attestation: the 4th calendar was not asked.
      expect(ots.upgrade).toHaveBeenCalledTimes(3);
      const row = anchor();
      expect(row.ots).toMatchObject({
        status: 'confirmed',
        bitcoinHeights: [870_123],
        nextAttemptAt: null,
      });
      expect(row.ots.lastError).toContain('timeout');
      expect(row.ots.lastError).toContain('not on the allowed list');
      const { digest, tree } = parseDetached(row.ots.proof);
      expect(digest.toString('hex')).toBe(row.merkleRoot);
      expect(summarize(tree).bitcoin).toHaveLength(1);
      expect((await service.run(later(30 * 24 * HOUR))).ots).toEqual([]);
    });

    it('lost leases write nothing, on submit and on upgrade', async () => {
      await service.build(NOW);
      ots.submit.mockImplementationOnce((root: string) => {
        anchor().ots.lease.id = 'thief';
        return Promise.resolve(calendarsAnswer(root));
      });
      expect((await service.run(NOW)).ots).toEqual([
        { anchorId: '2026-11-14', outcome: 'lease-lost' },
      ]);
      delete anchor().ots.lease;
      await service.run(NOW);
      ots.upgrade.mockImplementationOnce(() => {
        anchor().ots.lease.id = 'thief';
        return Promise.resolve({ state: 'pending' });
      });
      expect((await service.run(later(UPGRADE_INTERVAL_MS))).ots).toEqual([
        { anchorId: '2026-11-14', outcome: 'lease-lost' },
      ]);
    });

    it('a recorded attempt count carries on from where it was', async () => {
      await service.build(NOW);
      anchor().ots.attempts = undefined;
      anchor().tsa.attempts = undefined;
      await service.run(NOW);
      expect(anchor().ots.attempts).toBe(1);
      expect(anchor().tsa.attempts).toBe(1);
    });
  });

  describe('anchorOf', () => {
    it('says which anchor holds a version, and nothing for one not (yet) anchored', async () => {
      const v = addBlockVersion(m);
      expect(await service.anchorOf('block', v._id)).toBeUndefined();
      await service.run(NOW);
      const found = await service.anchorOf('block', v._id);
      expect(found?.anchor._id).toBe('2026-11-14');
      expect(found?.claim.versionHash).toBe(v.hash);
      const leaf = leafHash(v.hash, found?.claim.salt as string);
      expect(buildTree([leaf]).root).toBe(found?.anchor.merkleRoot);
      anchor().status = 'building';
      expect(await service.anchorOf('block', v._id)).toBeUndefined();
    });
  });
});
