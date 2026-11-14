/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- in-memory fake rows */
// Chunk 16 review round 9: one test per finding, each written to fail on
// the code before its fix.
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import {
  addBlockVersion,
  anchorModels,
  type AnchorModels,
  offlineAnchoring,
  verifierFor,
} from './anchoring-harness.mocks-spec';
import { type TimestampNode } from './ots';
import {
  buildReceipt,
  type Disclosure,
  type ReceiptVersionInput,
} from './receipt';
import { makeTestTsa } from './test-tsa.mocks-spec';
import { toRecord } from './version-records';

const tsa = makeTestTsa();
const HOUR = 60 * 60_000;
const day = (n: number) => new Date(Date.UTC(2026, 10, 1 + n, 4));
const id = (n: number) => day(n).toISOString().slice(0, 10);

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  jest.spyOn(Logger.prototype, 'error').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

type Row = Record<string, any>;
const anchorRow = (m: AnchorModels, n: number) =>
  m.anchors.docs.find((a) => a._id === id(n)) as Row;

/** Two anchors, each stamped and with a pending OpenTimestamps proof. */
async function twoPending() {
  const m = anchorModels();
  for (const n of [0, 1]) {
    addBlockVersion(m, { createdAt: new Date(day(n).getTime() - HOUR) });
    await offlineAnchoring(m, tsa).run(day(n));
    expect(anchorRow(m, n).ots.status).toBe('pending');
  }
  return m;
}

/** A chain of `depth` SHA-256 steps from `msg`, ending in `attestation`. */
function chain(
  msg: Buffer,
  depth: number,
  attestation: TimestampNode['attestations'][number],
): TimestampNode {
  if (depth === 0) return { msg, attestations: [attestation], ops: [] };
  const next = createHash('sha256').update(msg).digest();
  return {
    msg,
    attestations: [],
    ops: [{ op: { op: 0x08 }, child: chain(next, depth - 1, attestation) }],
  };
}

describe('L1: one bad OpenTimestamps answer never stops the others, nor grows the proof', () => {
  it('an answer nested near the depth limit is refused, and the next anchor is still processed', async () => {
    const m = await twoPending();
    const before = Buffer.from(anchorRow(m, 0).ots.proof);
    const asked: string[] = [];
    const report = await offlineAnchoring(m, tsa, {
      upgrade: (_uri, commitment) => {
        asked.push(commitment);
        // Within the limit from the graft point, past it in the whole proof.
        return Promise.resolve({
          state: 'upgraded',
          tree: chain(Buffer.from(commitment, 'hex'), 255, {
            kind: 'bitcoin',
            height: 975755,
          }),
        });
      },
    }).run(day(2));
    // Both anchors were tried, and neither stored a proof it cannot read.
    expect(report.ots.map((step) => step.anchorId)).toEqual([id(0), id(1)]);
    expect(anchorRow(m, 0).ots.status).toBe('pending');
    expect(Buffer.from(anchorRow(m, 0).ots.proof).equals(before)).toBe(true);
    expect(anchorRow(m, 0).ots.lastError).toContain('too deep');
    expect(anchorRow(m, 1).ots.status).toBe('pending');
  });

  it('a stored proof that cannot be read is recorded and backed off; the next anchor goes on', async () => {
    const m = await twoPending();
    anchorRow(m, 0).ots.proof = Buffer.from('not a proof');
    const report = await offlineAnchoring(m, tsa).run(day(2));
    expect(report.ots.map((step) => step.anchorId)).toEqual([id(0), id(1)]);
    expect(report.ots[0].outcome).toBe('failed');
    expect(anchorRow(m, 0).ots.lastError).toEqual(expect.any(String));
    expect(
      (anchorRow(m, 0).ots.nextAttemptAt as Date).getTime(),
    ).toBeGreaterThan(day(2).getTime());
  });

  it('an unreadable proof whose step lease was lost meanwhile reports lease-lost', async () => {
    const m = await twoPending();
    anchorRow(m, 0).ots.proof = Buffer.from('not a proof');
    const update = m.anchors.updateOne;
    m.anchors.updateOne = (filter, change, options) =>
      String((change.$set as Row | undefined)?.['ots.lastError']).includes(
        'cannot be read',
      )
        ? {
            exec: () => Promise.resolve({ matchedCount: 0, modifiedCount: 0 }),
          }
        : update(filter, change, options);
    const report = await offlineAnchoring(m, tsa).run(day(2));
    expect(report.ots[0]).toEqual({ anchorId: id(0), outcome: 'lease-lost' });
  });

  it('a 200 answer with no Bitcoin attestation does not grow the stored proof', async () => {
    const m = await twoPending();
    const before = Buffer.from(anchorRow(m, 0).ots.proof).length;
    const pendingOnly = (_uri: string, commitment: string) =>
      Promise.resolve({
        state: 'upgraded' as const,
        tree: chain(Buffer.from(commitment, 'hex'), 1, {
          kind: 'pending',
          uri: 'https://alice.btc.calendar.opentimestamps.org',
        }),
      });
    for (const n of [2, 3, 4]) {
      await offlineAnchoring(m, tsa, { upgrade: pendingOnly }).run(day(n));
    }
    expect(Buffer.from(anchorRow(m, 0).ots.proof).length).toBe(before);
    expect(anchorRow(m, 0).ots.status).toBe('pending');
    expect(anchorRow(m, 0).ots.lastError).toContain('no Bitcoin attestation');
  });
});

describe('L2: a stamp whose check failed is not a stamp; a failed hash or path is said plainly', () => {
  async function receiptWith(
    checks: Partial<Record<'hash' | 'path' | 'tsa' | 'ots', 'fail'>>,
    disclose: Disclosure,
  ) {
    const m = anchorModels();
    const v = addBlockVersion(m, {
      createdAt: new Date(day(0).getTime() - HOUR),
    });
    await offlineAnchoring(m, tsa).run(day(0));
    const record = toRecord('block', v);
    const proof = await verifierFor(m, tsa).proveVersion('block', record);
    if (!proof.anchored) throw new Error('expected an anchored proof');
    for (const [key, outcome] of Object.entries(checks)) {
      proof.checks[key as 'hash'] = { outcome, detail: 'synthetic' };
    }
    const input: ReceiptVersionInput = {
      kind: 'block',
      record,
      proof,
      disclose,
    };
    return buildReceipt(
      { type: 'belief-text', page: 'p', tabId: 't' },
      [input],
      { isAdmin: true },
    ).notice.join(' ');
  }

  it('a FreeTSA token whose check failed gives no time: pending', async () => {
    const text = await receiptWith({ tsa: 'fail' }, 'full');
    expect(text).toContain('no time-stamp yet');
    expect(text).not.toContain('no later than');
  });

  it.each(['full', 'hashes', 'none'] as const)(
    '%s: a failed hash or path check says the receipt could not be confirmed',
    async (disclose) => {
      for (const failed of ['hash', 'path'] as const) {
        const text = await receiptWith({ [failed]: 'fail' }, disclose);
        expect(text).toContain('could not be confirmed');
        expect(text).not.toContain('no later than');
      }
    },
  );
});

describe('L3: README step 5 says first whether the proof gives a time', () => {
  it('not yet confirmed in Bitcoin', async () => {
    const m = anchorModels();
    const v = addBlockVersion(m, {
      createdAt: new Date(day(0).getTime() - HOUR),
    });
    await offlineAnchoring(m, tsa).run(day(0));
    const record = toRecord('block', v);
    const receipt = buildReceipt(
      { type: 'belief-text', page: 'p', tabId: 't' },
      [
        {
          kind: 'block',
          record,
          proof: await verifierFor(m, tsa).proveVersion('block', record),
          disclose: 'full',
        },
      ],
      { isAdmin: true },
    );
    const step5 = receipt.howToVerify.find((line) => line.startsWith('5.'));
    expect(step5).toMatch(
      /^5\. OpenTimestamps, not yet confirmed in Bitcoin; it gives no time yet: /,
    );
    anchorRow(m, 0).ots.bitcoinHeights = [975755];
    const confirmed = buildReceipt(
      { type: 'belief-text', page: 'p', tabId: 't' },
      [
        {
          kind: 'block',
          record,
          proof: await verifierFor(m, tsa).proveVersion('block', record),
          disclose: 'full',
        },
      ],
      { isAdmin: true },
    );
    expect(confirmed.howToVerify.find((line) => line.startsWith('5.'))).toMatch(
      /^5\. OpenTimestamps, confirmed in Bitcoin block 975755: /,
    );
  });
});

describe('L4: a run that stops before its build says the build was not reached', () => {
  it('report.build is not-reached when the lock is lost before the build', async () => {
    const m = anchorModels();
    m.locks = fakeModel([], { unique: [['_id']] });
    addBlockVersion(m, { createdAt: new Date(day(0).getTime() - HOUR) });
    const update = m.locks.updateOne;
    let renewals = 0;
    m.locks.updateOne = (filter, change, options) => {
      const renewing =
        filter.holder !== undefined && (change.$set as Row | undefined)?.until;
      // 1 resume step, 2 sweep step, 3 build step: lost before the build.
      if (renewing && ++renewals >= 3) {
        return {
          exec: () => Promise.resolve({ matchedCount: 0, modifiedCount: 0 }),
        };
      }
      return update(filter, change, options);
    };
    const report = await offlineAnchoring(m, tsa).run(day(0));
    expect(report.interrupted).toBe(true);
    expect(report.build).toEqual({ state: 'not-reached' });
  });
});
