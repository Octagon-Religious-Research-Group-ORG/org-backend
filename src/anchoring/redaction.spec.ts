import { Types } from 'mongoose';
import {
  COMMENT_HASH_SCHEME,
  computeVersionHash,
} from '../social/version-chain';
import {
  parseRedaction,
  REDACTION_FORMAT,
  redactionKey,
  redactionRow,
  remainingHash,
} from './redaction';

// Chunk 17 round 2, #1: the redaction record is an ordinary comment-version
// row of a reserved chain, so the existing daily anchor covers it.
const record = {
  _id: new Types.ObjectId(),
  key: 'blk',
  seq: 2,
  text: 'Accepted wording',
  authorUserId: 'user_owner',
  createdAt: new Date('2026-11-14T00:00:00Z'),
  prevHash: '0'.repeat(64),
  hash: '1'.repeat(64),
  suggestionId: 'c-sugg',
};

const ACCOUNT = new Types.ObjectId();

describe('redaction records', () => {
  it('records the original hash and a hash of every kept field', () => {
    const row = redactionRow(record, new Date('2031-11-14T00:00:00Z'), ACCOUNT);
    expect(row.commentId).toBe(redactionKey(record._id));
    expect(parseRedaction(row.text)).toEqual({
      format: REDACTION_FORMAT,
      versionId: String(record._id),
      originalHash: record.hash,
      remainingHash: remainingHash(record),
      removed: ['suggestedBy'],
      accountId: String(ACCOUNT),
    });
    expect(row.hash).toBe(
      computeVersionHash(
        { ...row, blockId: row.commentId },
        COMMENT_HASH_SCHEME,
      ),
    );
    // Every kept field is covered: changing any one changes the hash.
    for (const changed of [
      { text: 'x' },
      { seq: 3 },
      { authorUserId: 'u' },
      { suggestionId: undefined },
    ]) {
      expect(remainingHash({ ...record, ...changed })).not.toBe(
        remainingHash(record),
      );
    }
  });

  it('reads nothing that is not a record', () => {
    for (const text of [
      'not json',
      'null',
      '{}',
      JSON.stringify({ format: REDACTION_FORMAT, versionId: 1 }),
      // Round 4, #2: a record that names no account deletion.
      JSON.stringify({
        format: REDACTION_FORMAT,
        versionId: 'v',
        originalHash: 'h',
        remainingHash: 'r',
      }),
    ]) {
      expect(parseRedaction(text)).toBeUndefined();
    }
  });
});
