/* eslint-disable @typescript-eslint/no-unsafe-member-access -- in-memory fake rows */
// Chunk 16 review round 10: one test per finding, each written to fail on
// the code before its fix.
import { Logger } from '@nestjs/common';
import {
  addBlockVersion,
  anchorModels,
  offlineAnchoring,
  verifierFor,
} from './anchoring-harness.mocks-spec';
import * as receiptModule from './receipt';
import { buildReceipt } from './receipt';
import { makeTestTsa } from './test-tsa.mocks-spec';
import { toRecord } from './version-records';

const tsa = makeTestTsa();
const D0 = new Date('2026-11-01T04:00:00Z');

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

/** A stamped receipt whose OpenTimestamps check this server failed. */
async function otsCheckFailed(heights: number[]) {
  const m = anchorModels();
  const v = addBlockVersion(m, {
    createdAt: new Date(D0.getTime() - 3_600_000),
  });
  await offlineAnchoring(m, tsa).run(D0);
  const row = m.anchors.docs[0] as Record<string, any>;
  delete row.tsa.response;
  row.ots.bitcoinHeights = heights;
  const record = toRecord('block', v);
  const proof = await verifierFor(m, tsa).proveVersion('block', record);
  if (!proof.anchored) throw new Error('expected an anchored proof');
  proof.checks.ots = {
    outcome: 'fail',
    detail: 'the proof is for another digest',
  };
  return buildReceipt(
    { type: 'belief-text', page: 'p', tabId: 't' },
    [{ kind: 'block', record, proof, disclose: 'full' }],
    { isAdmin: true },
  );
}

describe('LOW-1: an OpenTimestamps proof whose check failed is neither "in" nor "confirmed"', () => {
  it('the notice is pending, without the "in but not yet confirmed" line', async () => {
    const text = (await otsCheckFailed([])).notice.join(' ');
    expect(text).toContain('no time-stamp yet');
    expect(text).not.toContain('An OpenTimestamps proof is in');
  });

  it('step 5 says this server’s check of the proof failed, with its detail', async () => {
    const receipt = await otsCheckFailed([975755]);
    const step5 = receipt.howToVerify.find((line) => line.startsWith('5.'));
    expect(step5).toMatch(
      /^5\. OpenTimestamps, this server's check of the proof failed: the proof is for another digest: /,
    );
    expect(step5).not.toContain('confirmed in Bitcoin block');
  });
});

describe('LOW-2: every receipt notice uses straight apostrophes', () => {
  it('no notice line holds a curly one', () => {
    const notices = Object.entries(receiptModule).filter(
      ([name, value]) => name.endsWith('_NOTICE') && Array.isArray(value),
    );
    expect(notices.length).toBeGreaterThanOrEqual(7);
    for (const [name, lines] of notices) {
      for (const line of lines as string[]) {
        expect([name, line.includes('’')]).toEqual([name, false]);
      }
    }
  });
});
