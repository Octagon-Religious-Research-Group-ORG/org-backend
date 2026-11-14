import { Types } from 'mongoose';
import {
  COMMENT_HASH_SCHEME,
  computeVersionHash,
  GENESIS_HASH,
} from '../social/version-chain';
import {
  ACCOUNT_DELETED_FORMAT,
  ACCOUNT_DELETED_PART_SIZE,
  accountDeletedKey,
  accountDeletedRows,
  parseAccountDeleted,
} from './account-deletion-record';

// Chunk 17 review round 4, #2: the webhook's anchored record of which
// comments a deleted account had authored. Ids only.
const ACCOUNT = new Types.ObjectId();
const AT = new Date('2026-11-14T00:00:00Z');

describe('account-deletion records', () => {
  it('records the account row, the time and the sorted comment ids', () => {
    const [row, ...rest] = accountDeletedRows(ACCOUNT, AT, [
      'c-b',
      'c-a',
      'c-b',
    ]);
    expect(rest).toHaveLength(0);
    expect(row.commentId).toBe(accountDeletedKey(ACCOUNT));
    expect(row).toMatchObject({
      seq: 1,
      createdAt: AT,
      prevHash: GENESIS_HASH,
    });
    expect(parseAccountDeleted(row.text)).toEqual({
      format: ACCOUNT_DELETED_FORMAT,
      accountId: String(ACCOUNT),
      deletedAt: AT.toISOString(),
      part: 1,
      parts: 1,
      commentIds: ['c-a', 'c-b'],
    });
    expect(row.hash).toBe(
      computeVersionHash(
        { ...row, blockId: row.commentId },
        COMMENT_HASH_SCHEME,
      ),
    );
  });

  it('writes one empty part for an account with no comments', () => {
    const rows = accountDeletedRows(ACCOUNT, AT, []);
    expect(rows).toHaveLength(1);
    expect(parseAccountDeleted(rows[0].text)?.commentIds).toEqual([]);
  });

  it('splits a long list over a linked chain', () => {
    const ids = Array.from(
      { length: ACCOUNT_DELETED_PART_SIZE + 1 },
      (_, i) => `c-${String(i).padStart(4, '0')}`,
    );
    const rows = accountDeletedRows(ACCOUNT, AT, ids);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[1].prevHash).toBe(rows[0].hash);
    expect(parseAccountDeleted(rows[1].text)).toMatchObject({
      part: 2,
      parts: 2,
      commentIds: [ids[ACCOUNT_DELETED_PART_SIZE]],
    });
  });

  it('reads anything else as no record', () => {
    expect(parseAccountDeleted('not json')).toBeUndefined();
    expect(parseAccountDeleted('null')).toBeUndefined();
    expect(parseAccountDeleted('{"format":"other"}')).toBeUndefined();
    const good = JSON.parse(
      accountDeletedRows(ACCOUNT, AT, ['c'])[0].text,
    ) as Record<string, unknown>;
    for (const broken of [
      { accountId: 1 },
      { deletedAt: 1 },
      { part: 'x' },
      { parts: 1.5 },
      { commentIds: 'c' },
      { commentIds: [1] },
    ]) {
      expect(
        parseAccountDeleted(JSON.stringify({ ...good, ...broken })),
      ).toBeUndefined();
    }
  });
});
