/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- in-memory fake rows */
// Chunk 16 review round 8: one test per finding, each written to fail on
// the code before its fix.
import { Logger } from '@nestjs/common';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import {
  addBlockVersion,
  anchorModels,
  type AnchorModels,
  offlineAnchoring,
  verifierFor,
} from './anchoring-harness.mocks-spec';
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

let error: jest.SpyInstance;
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

type Row = Record<string, any>;
const anchorRow = (m: AnchorModels, n: number) =>
  m.anchors.docs.find((a) => a._id === id(n)) as Row;
const withLocks = () => {
  const m = anchorModels();
  m.locks = fakeModel([], { unique: [['_id']] });
  return m;
};

describe('LOW-1 and LOW-2: a receipt claims only the stamps that give a time', () => {
  /** Day 0 anchored and stamped with one version per anchor. */
  async function stampedVersion(m: AnchorModels, n: number) {
    const v = addBlockVersion(m, {
      createdAt: new Date(day(n).getTime() - HOUR),
    });
    await offlineAnchoring(m, tsa).run(day(n));
    return v;
  }
  async function receiptOf(
    m: AnchorModels,
    versions: Array<ReturnType<typeof addBlockVersion>>,
    disclose: Disclosure = 'full',
  ) {
    const inputs: ReceiptVersionInput[] = [];
    for (const v of versions) {
      const record = toRecord('block', v);
      inputs.push({
        kind: 'block' as const,
        record,
        proof: await verifierFor(m, tsa).proveVersion('block', record),
        disclose,
      });
    }
    return buildReceipt(
      { type: 'belief-text', page: 'p', tabId: 't' },
      inputs,
      { isAdmin: true },
    ).notice.join(' ');
  }

  it('only an OpenTimestamps proof not yet in Bitcoin: pending, and says why', async () => {
    const m = anchorModels();
    const v = await stampedVersion(m, 0);
    delete anchorRow(m, 0).tsa.response;
    expect(anchorRow(m, 0).ots.bitcoinHeights ?? []).toEqual([]);
    const text = await receiptOf(m, [v]);
    expect(text).toContain('no time-stamp yet');
    expect(text).toContain(
      'An OpenTimestamps proof is in but not yet confirmed in a Bitcoin block, so it gives no time yet.',
    );
    expect(text).not.toContain('the OpenTimestamps proof gives');
  });

  it('an OpenTimestamps proof confirmed in Bitcoin counts as a stamp', async () => {
    const m = anchorModels();
    const v = await stampedVersion(m, 0);
    delete anchorRow(m, 0).tsa.response;
    anchorRow(m, 0).ots.bitcoinHeights = [975755];
    const text = await receiptOf(m, [v]);
    expect(text).toContain(
      'the OpenTimestamps proof, confirmed in Bitcoin, gives (the FreeTSA time-stamp is not in yet)',
    );
    expect(text).not.toContain('no time-stamp yet');
  });

  it('a FreeTSA token with an unconfirmed proof names only FreeTSA', async () => {
    const m = anchorModels();
    const v = await stampedVersion(m, 0);
    const text = await receiptOf(m, [v]);
    expect(text).toContain(
      'the FreeTSA time-stamp gives (the OpenTimestamps proof is not confirmed in Bitcoin yet)',
    );
  });

  it('versions with different stamps: stamped, with a neutral sentence', async () => {
    const m = anchorModels();
    const a = await stampedVersion(m, 0);
    const b = await stampedVersion(m, 1);
    // a: FreeTSA only; b: Bitcoin-confirmed OpenTimestamps only.
    delete anchorRow(m, 1).tsa.response;
    anchorRow(m, 1).ots.bitcoinHeights = [975755];
    const text = await receiptOf(m, [a, b]);
    expect(text).not.toContain('no time-stamp yet');
    expect(text).toContain(
      'some versions hold only one of the two time-stamps',
    );
  });
});

describe('LOW-3: the lock never replaces the run’s own outcome', () => {
  it('a failing release does not replace the run’s result, and says when the lock frees itself', async () => {
    const m = withLocks();
    addBlockVersion(m, { createdAt: new Date(day(0).getTime() - HOUR) });
    const update = m.locks!.updateOne;
    m.locks!.updateOne = (filter, change, options) =>
      change.$unset
        ? { exec: () => Promise.reject(new Error('synthetic release failure')) }
        : update(filter, change, options);
    const report = await offlineAnchoring(m, tsa).run(day(0));
    expect(report.build).toMatchObject({ state: 'built' });
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        /synthetic release failure.*frees itself at \d{4}-\d{2}-\d{2}T/,
      ),
    );
  });

  it('a failing release does not replace the run’s own error', async () => {
    const m = withLocks();
    const update = m.locks!.updateOne;
    m.locks!.updateOne = (filter, change, options) =>
      change.$unset
        ? { exec: () => Promise.reject(new Error('synthetic release failure')) }
        : update(filter, change, options);
    m.anchors.find = () => {
      throw new Error('the run’s own failure');
    };
    await expect(offlineAnchoring(m, tsa).run(day(0))).rejects.toThrow(
      'the run’s own failure',
    );
  });

  it('a failure while confirming the lock releases it', async () => {
    const m = withLocks();
    const findOne = m.locks!.findOne;
    m.locks!.findOne = () => {
      throw new Error('synthetic confirm failure');
    };
    await expect(offlineAnchoring(m, tsa).run(day(0))).rejects.toThrow(
      'synthetic confirm failure',
    );
    m.locks!.findOne = findOne;
    expect(m.locks!.docs[0].holder).toBeUndefined();
  });
});

describe('LOW-4: the lock is renewed for each anchor resumed or swept', () => {
  /** The Nth renewal and every one after it finds another holder. */
  function lockLostAtRenewal(m: AnchorModels, n: number) {
    const update = m.locks!.updateOne;
    let renewals = 0;
    m.locks!.updateOne = (filter, change, options) => {
      const renewing =
        filter.holder !== undefined && (change.$set as Row | undefined)?.until;
      if (renewing && ++renewals >= n) {
        return {
          exec: () => Promise.resolve({ matchedCount: 0, modifiedCount: 0 }),
        };
      }
      return update(filter, change, options);
    };
  }

  it('resuming: stops before the next stale anchor once the lock is lost', async () => {
    const m = withLocks();
    for (const n of [0, 1]) {
      await m.anchors.create({
        _id: id(n),
        status: 'building',
        cutoff: new Date(day(n).getTime() - 2 * 60_000),
      });
    }
    // Renewals: 1 before the resume step, 2 before day 0, 3 before day 1.
    lockLostAtRenewal(m, 3);
    const report = await offlineAnchoring(m, tsa).run(day(3));
    expect(report.interrupted).toBe(true);
    expect(
      report.resumed.map((r) => (r as { anchorId: string }).anchorId),
    ).toEqual([id(0)]);
    expect(anchorRow(m, 1).status).toBe('building');
  });

  it('sweeping: stops before the next anchor once the lock is lost', async () => {
    const m = withLocks();
    for (const n of [0, 1]) {
      addBlockVersion(m, { createdAt: new Date(day(n).getTime() - HOUR) });
      expect((await offlineAnchoring(m, tsa).build(day(n))).state).toBe(
        'built',
      );
      const late = addBlockVersion(m, {
        createdAt: new Date(day(n).getTime() - 3 * HOUR),
      });
      m.leaves.docs.push({
        _id: `b:${String(late._id)}`,
        anchorId: id(n),
        kind: 'block',
        versionId: late._id,
        versionHash: late.hash,
        versionCreatedAt: late.createdAt,
        salt: 'c'.repeat(64),
      });
    }
    // Renewals: 1 resume step, 2 sweep step, 3 first anchor, 4 second.
    lockLostAtRenewal(m, 4);
    const report = await offlineAnchoring(m, tsa).run(day(2));
    expect(report.interrupted).toBe(true);
    expect(report.released).toHaveLength(1);
  });
});
