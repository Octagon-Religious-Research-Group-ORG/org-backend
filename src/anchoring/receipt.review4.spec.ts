// Chunk 16 review round 4, LOW-2: written to fail on the code before the fix.
import { unzipSync, strFromU8 } from 'fflate';
import { addBlockVersion, anchorModels } from './anchoring-harness.mocks-spec';
import {
  buildReceipt,
  HASHES_PENDING_RECEIPT_NOTICE,
  HASHES_RECEIPT_NOTICE,
  PARTIAL_PENDING_RECEIPT_NOTICE,
  PARTIAL_RECEIPT_NOTICE,
  RECEIPT_NOTICE,
  RECEIPT_PENDING_NOTICE,
  receiptZip,
  type Disclosure,
} from './receipt';
import { toRecord } from './version-records';

describe('LOW-2: a pending download never claims a time-stamp exists', () => {
  const cases: Array<[Disclosure, string[], string[]]> = [
    ['full', RECEIPT_NOTICE, RECEIPT_PENDING_NOTICE],
    ['hashes', HASHES_RECEIPT_NOTICE, HASHES_PENDING_RECEIPT_NOTICE],
    ['none', PARTIAL_RECEIPT_NOTICE, PARTIAL_PENDING_RECEIPT_NOTICE],
  ];
  it.each(cases)(
    '%s: the pending notice, in receipt.json and README.txt',
    (disclose, done, pending) => {
      const m = anchorModels();
      const record = toRecord('block', addBlockVersion(m));
      const receipt = buildReceipt(
        { type: 'belief-text', page: 'p', tabId: 't' },
        [{ kind: 'block', record, proof: { anchored: false }, disclose }],
        { isAdmin: disclose === 'full' },
      );
      expect(receipt.notice).toEqual(pending);
      expect(pending).not.toEqual(done);
      const text = pending.join(' ');
      expect(text).toContain('no time-stamp yet');
      expect(text).not.toContain('no later than the times');
      const files = unzipSync(receiptZip(receipt));
      expect(strFromU8(files['README.txt'])).toContain('no time-stamp yet');
      expect(
        (JSON.parse(strFromU8(files['receipt.json'])) as { notice: string[] })
          .notice,
      ).toEqual(pending);
    },
  );
});
