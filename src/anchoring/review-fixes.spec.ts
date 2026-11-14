/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- in-memory fake rows */
// Chunk 16 independent review: one test per finding, each written to fail
// on the code before its fix.
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  addBlockVersion,
  addCommentVersion,
  anchorModels,
  type AnchorModels,
  offlineAnchoring,
  verifierFor,
} from './anchoring-harness.mocks-spec';
import { checkOts } from './anchor-verifier.service';
import { AdminAnchorsController } from './anchoring.controller';
import { parseDetached, parseTimestamp, serializeDetached } from './ots';
import { fetchBytes, MAX_RESPONSE_BYTES } from './providers';
import * as rfc3161 from './rfc3161';
import { STEP0_DIGEST, STEP0_OTS_FILE } from './step0-fixtures.mocks-spec';
import { makeTestTsa } from './test-tsa.mocks-spec';
import { buildReceipt, receiptZip } from './receipt';
import { toRecord } from './version-records';
import { strFromU8, unzipSync } from 'fflate';

const tsa = makeTestTsa();
const DAY = 24 * 3_600_000;
const D1 = new Date('2026-11-14T04:00:00Z');
const at = (ms: number) => new Date(D1.getTime() + ms);

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

const anchor = (m: AnchorModels, id: string) =>
  m.anchors.docs.find((d) => d._id === id) as Record<string, any>;

describe('H1: a build that died after its claims is finished later', () => {
  it('a crash between the claims and the root write is resumed on the next day', async () => {
    const m = anchorModels();
    const old = [addBlockVersion(m), addCommentVersion(m)];
    const service = offlineAnchoring(m, tsa);
    const update = m.anchors.updateOne;
    let crashed = false;
    m.anchors.updateOne = (filter, change) => {
      if (!crashed && (change as any).$set?.status === 'built') {
        crashed = true;
        throw new Error('process killed');
      }
      return update(filter, change);
    };
    await expect(service.run(D1)).rejects.toThrow('process killed');
    expect(anchor(m, '2026-11-14').status).toBe('building');
    expect(m.leaves.docs).toHaveLength(2);

    addBlockVersion(m, { createdAt: at(DAY / 2) });
    const report = await offlineAnchoring(m, tsa).run(at(DAY));
    expect(anchor(m, '2026-11-14')).toMatchObject({ status: 'built' });
    expect(
      anchor(m, '2026-11-14')
        .leaves.map((l: any) => String(l.versionId))
        .sort(),
    ).toEqual(old.map((v) => String(v._id)).sort());
    expect(report.resumed).toEqual([
      { state: 'built', anchorId: '2026-11-14', leaves: 2 },
    ]);
    expect(anchor(m, '2026-11-15')).toMatchObject({ status: 'built' });
    expect(anchor(m, '2026-11-14').tsa.status).toBe('granted');
  });

  it('coverage is not a pass while a claim points at an anchor that is not built', async () => {
    const m = anchorModels();
    addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(D1);
    const stuck = addBlockVersion(m, { createdAt: at(-3_600_000) });
    await m.leaves.create({
      _id: `b:${String(stuck._id)}`,
      anchorId: '2026-11-13',
      kind: 'block',
      versionId: stuck._id,
      versionHash: stuck.hash,
      versionCreatedAt: stuck.createdAt,
    });
    await m.anchors.create({
      _id: '2026-11-13',
      status: 'building',
      lease: { id: 'dead', until: at(-DAY) },
    });
    const health = await verifierFor(m, tsa).verifyAll(at(1000));
    expect(health.coverage.outcome).toBe('fail');
    expect(health.coverage.detail).toContain(`b:${String(stuck._id)}`);
    // An anchor row that is missing altogether is no better.
    m.anchors.docs.splice(
      m.anchors.docs.findIndex((d) => d._id === '2026-11-13'),
      1,
    );
    expect((await verifierFor(m, tsa).verifyAll()).coverage.outcome).toBe(
      'fail',
    );
  });
});

describe('M1: the daily cap never loses a version, and does not starve comments', () => {
  it('a first run over a long history anchors everything over the next days', async () => {
    const m = anchorModels();
    const versions = Array.from({ length: 7 }, (_, i) =>
      addBlockVersion(m, { createdAt: new Date(Date.UTC(2026, 8, 1 + i)) }),
    );
    for (let day = 0; day < 4; day++) {
      const service = offlineAnchoring(m, tsa);
      service.maxLeaves = 3;
      await service.run(at(day * DAY));
    }
    const claimed = new Set(m.leaves.docs.map((d) => String(d.versionId)));
    expect(versions.filter((v) => !claimed.has(String(v._id)))).toEqual([]);
    expect(m.leaves.docs).toHaveLength(7);
  });

  it('fills the cap with the oldest versions of either kind', async () => {
    const m = anchorModels();
    for (let i = 0; i < 3; i++) {
      addBlockVersion(m, { createdAt: new Date(Date.UTC(2026, 10, 10, i)) });
    }
    const comments = [1, 2].map((i) =>
      addCommentVersion(m, { createdAt: new Date(Date.UTC(2026, 10, 1, i)) }),
    );
    const service = offlineAnchoring(m, tsa);
    service.maxLeaves = 3;
    await service.run(D1);
    const ids = anchor(m, '2026-11-14').leaves.map((l: any) =>
      String(l.versionId),
    );
    for (const c of comments) expect(ids).toContain(String(c._id));
  });
});

describe('M4: an answer past the cap is cut off while it streams', () => {
  it('stops reading a chunked body with no length and cancels it', async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 200) controller.close();
        else controller.enqueue(new Uint8Array(16 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(body));
    await expect(
      fetchBytes('https://x.example.test', {}, 1000),
    ).rejects.toThrow('answer too large');
    expect(pulls).toBeLessThan(MAX_RESPONSE_BYTES / (16 * 1024) + 3);
    expect(cancelled).toBe(true);
  });
});

describe('L1: a receipt does not redo the whole anchor every time', () => {
  it('checks a built anchor’s token once, and again only if it changed', async () => {
    const m = anchorModels();
    const v = [addBlockVersion(m), addBlockVersion(m)];
    await offlineAnchoring(m, tsa).run(D1);
    const verify = jest.spyOn(rfc3161, 'verifyTimestampToken');
    const verifier = verifierFor(m, tsa);
    for (const version of v) {
      const proof = await verifier.proveVersion(
        'block',
        toRecord('block', version),
      );
      expect(proof.anchored && proof.checks.tsa.outcome).toBe('pass');
    }
    expect(verify).toHaveBeenCalledTimes(1);
    anchor(m, '2026-11-14').tsa.response = Buffer.from('replaced');
    const after = await verifier.proveVersion('block', toRecord('block', v[0]));
    expect(after.anchored && after.checks.tsa.outcome).toBe('fail');
  });

  it('the admin list is paged', async () => {
    const m = anchorModels();
    for (let i = 0; i < 35; i++) {
      await m.anchors.create({
        _id: `2026-10-${String(i + 1).padStart(2, '0')}x`,
        status: 'empty',
      });
    }
    const controller = new AdminAnchorsController(
      m.anchors as never,
      verifierFor(m, tsa),
      { enabled: true } as never,
      {} as never,
    );
    const first = await controller.list({});
    expect(first.anchors).toHaveLength(30);
    expect(first.hasMore).toBe(true);
    const second = await controller.list({ page: 2 });
    expect(second.anchors).toHaveLength(5);
    expect(second.hasMore).toBe(false);
  });
});

describe('L2: the signer is picked by issuer AND serial, and the root must be valid then', () => {
  const digest = createHash('sha256').update('l2').digest('hex');
  const token = (t: ReturnType<typeof makeTestTsa>) =>
    rfc3161.parseTimestampResponse(t.respond(digest)).token as Buffer;

  it('a certificate with the same serial from another issuer is not the signer', () => {
    const withDecoy = makeTestTsa({ decoy: true });
    expect(
      rfc3161.verifyTimestampToken(token(withDecoy), digest, [withDecoy.root])
        .outcome,
    ).toBe('pass');
  });

  it('a root that had expired at the stamped time is not trusted', () => {
    const expired = makeTestTsa({ rootNotAfter: new Date('2026-01-01Z') });
    expect(
      rfc3161.verifyTimestampToken(token(expired), digest, [expired.root]),
    ).toEqual({
      outcome: 'fail',
      reason: 'a certificate in the chain was not valid at that time',
    });
  });
});

describe('L3: a proof that attests nothing is not a pass', () => {
  it('no pending and no Bitcoin attestation', () => {
    const msg = Buffer.from(STEP0_DIGEST, 'hex');
    const proof = serializeDetached(msg, {
      msg,
      attestations: [
        { kind: 'unknown', tag: '1122334455667788', payload: Buffer.alloc(0) },
      ],
      ops: [],
    });
    expect(checkOts(proof, STEP0_DIGEST).ots.outcome).toBe('cannot-measure');
  });
});

describe('L4: numbers and versions in a proof', () => {
  it('a varuint beyond the safe integer range is refused', () => {
    const huge = Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from('0588960d73d71901', 'hex'),
      Buffer.from([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]),
    ]);
    expect(() => parseTimestamp(huge, Buffer.alloc(32))).toThrow(
      'varuint too large',
    );
  });

  it('the version is read as a varuint, whatever its length', () => {
    const magic = STEP0_OTS_FILE.subarray(0, 31);
    const rest = STEP0_OTS_FILE.subarray(32);
    // Version 1 written in two bytes (0x81 0x00).
    const file = Buffer.concat([magic, Buffer.from([0x81, 0x00]), rest]);
    expect(parseDetached(file).digest.toString('hex')).toBe(STEP0_DIGEST);
  });
});

describe('M3: a receipt without the hash input says what it can and cannot prove', () => {
  it('for anyone but the author, it proves only that the hash existed', async () => {
    const m = anchorModels();
    const v = addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(D1);
    const record = toRecord('block', v);
    const proof = await verifierFor(m, tsa).proveVersion('block', record);
    const subject = { type: 'belief-text' as const, page: 'p', tabId: 't' };
    const partial = buildReceipt(subject, [{ kind: 'block', record, proof }], {
      isAdmin: false,
    });
    const text = partial.notice.join(' ');
    expect(text).toContain(
      'proves only that this version’s sealed fingerprint (its leaf in the anchor) existed',
    );
    expect(text).toContain('only with the complete receipt');
    expect(text).not.toContain('exactly as written');
    expect(strFromU8(unzipSync(receiptZip(partial))['README.txt'])).toContain(
      'only with the complete receipt',
    );
    const full = buildReceipt(subject, [{ kind: 'block', record, proof }], {
      userId: 'user_owner',
      isAdmin: false,
    });
    expect(full.notice.join(' ')).toContain('exactly as written');
    expect(full.notice.join(' ')).not.toContain('complete receipt');
  });
});

describe('review fixes: the remaining edges', () => {
  it('H1: before any anchor is built, a stuck claim already fails coverage', async () => {
    const m = anchorModels();
    const v = addBlockVersion(m);
    await m.leaves.create({
      _id: `b:${String(v._id)}`,
      anchorId: '2026-11-13',
      kind: 'block',
      versionId: v._id,
      versionHash: v.hash,
      versionCreatedAt: v.createdAt,
    });
    const health = await verifierFor(m, tsa).verifyAll(D1);
    expect(health.coverage.outcome).toBe('fail');
  });

  it('H1: a build still holding its lease is in progress, not a failure', async () => {
    const m = anchorModels();
    addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(D1);
    const v = addBlockVersion(m);
    await m.leaves.create({
      _id: `b:${String(v._id)}`,
      anchorId: '2026-11-15',
      kind: 'block',
      versionId: v._id,
      versionHash: v.hash,
      versionCreatedAt: v.createdAt,
    });
    await m.anchors.create({
      _id: '2026-11-15',
      status: 'building',
      lease: { id: 'live', until: at(DAY) },
    });
    expect((await verifierFor(m, tsa).verifyAll(D1)).coverage.outcome).toBe(
      'pass',
    );
  });

  it('H1: a stale build another instance takes over first is left to it', async () => {
    const m = anchorModels();
    await m.anchors.create({
      _id: '2026-11-13',
      status: 'building',
      lease: { id: 'dead', until: at(-DAY) },
      cutoff: at(-DAY),
    });
    const service = offlineAnchoring(m, tsa);
    const take = m.anchors.findOneAndUpdate;
    m.anchors.findOneAndUpdate = (filter, change, options) => {
      // The other instance wins the takeover a moment before us.
      (m.anchors.docs[0] as any).lease = { id: 'other', until: at(DAY) };
      return take(filter, change, options);
    };
    expect((await service.run(D1)).resumed).toEqual([]);
    expect(anchor(m, '2026-11-13').lease.id).toBe('other');
  });

  it('M4: an answer with no body is empty', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    expect(
      (await fetchBytes('https://x.example.test', {}, 1000)).body.length,
    ).toBe(0);
  });

  it('L2: a version-1 certificate in the list is read too', () => {
    const digest = createHash('sha256').update('v1').digest('hex');
    const withV1 = makeTestTsa({ decoy: 'v1' });
    const token = rfc3161.parseTimestampResponse(withV1.respond(digest))
      .token as Buffer;
    expect(
      rfc3161.verifyTimestampToken(token, digest, [withV1.root]).outcome,
    ).toBe('pass');
  });

  it('L1: the kept checks are bounded, and an altered anchor is a failed proof', async () => {
    const m = anchorModels();
    const a = addBlockVersion(m);
    await offlineAnchoring(m, tsa).run(D1);
    const b = addBlockVersion(m, { createdAt: at(DAY / 2) });
    await offlineAnchoring(m, tsa).run(at(DAY));
    const verifier = verifierFor(m, tsa);
    verifier.anchorCacheLeaves = 1;
    const verify = jest.spyOn(rfc3161, 'verifyTimestampToken');
    for (const v of [a, b, a]) {
      await verifier.proveVersion('block', toRecord('block', v));
    }
    // Only one kept: the first anchor was checked again after the second.
    expect(verify).toHaveBeenCalledTimes(3);
    const row = anchor(m, '2026-11-14');
    delete row.merkleRoot;
    delete row.leaves;
    const proof = await verifier.proveVersion('block', toRecord('block', a));
    expect(proof.anchored && proof.checks.path.outcome).toBe('fail');
  });
});
