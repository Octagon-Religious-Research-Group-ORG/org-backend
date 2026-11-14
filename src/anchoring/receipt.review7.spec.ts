/* eslint-disable @typescript-eslint/no-unsafe-member-access -- in-memory fake rows */
// Chunk 16 review round 7, LOW-3: a receipt claims only the stamps it
// holds. Written to fail on the code before the fix.
import { Logger } from '@nestjs/common';
import {
  addBlockVersion,
  anchorModels,
  type AnchorModels,
  offlineAnchoring,
  verifierFor,
} from './anchoring-harness.mocks-spec';
import { buildReceipt, type Disclosure } from './receipt';
import { makeTestTsa } from './test-tsa.mocks-spec';
import { toRecord } from './version-records';

const tsa = makeTestTsa();
const D0 = new Date('2026-11-01T04:00:00Z');

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

async function receiptOf(
  m: AnchorModels,
  v: ReturnType<typeof addBlockVersion>,
  disclose: Disclosure,
) {
  const record = toRecord('block', v);
  const proof = await verifierFor(m, tsa).proveVersion('block', record);
  return buildReceipt(
    { type: 'belief-text', page: 'p', tabId: 't' },
    [{ kind: 'block', record, proof, disclose }],
    { isAdmin: disclose === 'full' },
  );
}

const DISCLOSURES: Disclosure[] = ['full', 'hashes', 'none'];

describe('LOW-3: the notice names the stamps the receipt holds', () => {
  it.each(DISCLOSURES)(
    '%s: anchored, but neither proof received yet: the pending wording',
    async (disclose) => {
      const m = anchorModels();
      const v = addBlockVersion(m, {
        createdAt: new Date(D0.getTime() - 60 * 60_000),
      });
      await offlineAnchoring(m, tsa).build(D0);
      const receipt = await receiptOf(m, v, disclose);
      expect(receipt.versions[0].anchor.state).toBe('anchored');
      const text = receipt.notice.join(' ');
      expect(text).toContain('no time-stamp yet');
      expect(text).not.toContain('no later than');
    },
  );

  it.each([
    [
      'FreeTSA only',
      (row: Record<string, any>) => delete row.ots.proof,
      'the FreeTSA time-stamp gives (the OpenTimestamps proof is not confirmed in Bitcoin yet)',
    ],
    [
      'OpenTimestamps only (confirmed in Bitcoin, round 8)',
      (row: Record<string, any>) => {
        delete row.tsa.response;
        row.ots.bitcoinHeights = [975755];
      },
      'the OpenTimestamps proof, confirmed in Bitcoin, gives (the FreeTSA time-stamp is not in yet)',
    ],
    [
      'both (OpenTimestamps confirmed in Bitcoin, round 8)',
      (row: Record<string, any>) => {
        row.ots.bitcoinHeights = [975755];
      },
      'the two independent time-stamps give',
    ],
  ])('%s: the notice says exactly which', async (_which, drop, phrase) => {
    for (const disclose of DISCLOSURES) {
      const m = anchorModels();
      const v = addBlockVersion(m, {
        createdAt: new Date(D0.getTime() - 60 * 60_000),
      });
      await offlineAnchoring(m, tsa).run(D0);
      drop(m.anchors.docs[0] as Record<string, any>);
      const text = (await receiptOf(m, v, disclose)).notice.join(' ');
      expect(text).toContain(phrase);
      expect(text).not.toContain('no time-stamp yet');
    }
  });
});
