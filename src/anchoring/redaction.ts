import { createHash } from 'node:crypto';
import { Types } from 'mongoose';

const { ObjectId } = Types;
import {
  COMMENT_HASH_SCHEME,
  computeVersionHash,
  GENESIS_HASH,
} from '../social/version-chain';
import type { VersionRecord } from './version-records';

/**
 * A redaction record (Chunk 17 review round 2, #1): written, append-only,
 * BEFORE the purge removes a purged suggester's id from a version on a live
 * page. It says which version lost which field, the version's original
 * hash, and the SHA-256 of everything the version keeps.
 *
 * It is stored as the first and only version of a reserved comment-version
 * chain, `redaction:<versionId>`. So the existing daily anchor picks it up
 * like any other comment version: same Merkle v2 leaf, same claims, same
 * cap and resume. No second scheme exists. No comment row has that id, so
 * no thread, export or search ever shows it.
 *
 * The verifier then proves the rest of the version: its remaining fields
 * must give the anchored remaining hash, and the version's stored hash must
 * be the original one. Only the removed suggester id cannot be measured.
 */
export const REDACTION_FORMAT = 'org-redaction-v1';
export const REDACTION_PREFIX = 'redaction:';
/** The purge job as the record's author (not a person). */
export const REDACTION_AUTHOR = 'system:purge';

/**
 * The redaction row's own id, derived from the version (round 6, 1a): a
 * re-issued redaction can only reuse it, so every anchor that ever held the
 * first one is found by `leaves.versionId` and the first hash wins.
 */
export function redactionId(
  versionId: Types.ObjectId | string,
): Types.ObjectId {
  return new ObjectId(
    createHash('sha256')
      .update(redactionKey(versionId), 'utf8')
      .digest('hex')
      .slice(0, 24),
  );
}

export function redactionKey(versionId: Types.ObjectId | string): string {
  return `${REDACTION_PREFIX}${String(versionId)}`;
}

/** The canonical form of what a version keeps once `suggestedBy` is removed. */
export function remainingCanonical(record: VersionRecord): string {
  return JSON.stringify([
    REDACTION_FORMAT,
    'suggestedBy removed',
    record.key,
    record.seq,
    record.text,
    record.authorUserId,
    record.createdAt.toISOString(),
    record.prevHash,
    record.suggestionId ?? '',
  ]);
}

export function remainingHash(record: VersionRecord): string {
  return createHash('sha256')
    .update(remainingCanonical(record), 'utf8')
    .digest('hex');
}

export interface RedactionClaim {
  format: string;
  versionId: string;
  originalHash: string;
  remainingHash: string;
  removed: string[];
  /**
   * The `accountdeletions` row of the purged suggester (round 4, #2): the
   * verifier accepts the record only with that account's anchored
   * deletion record (`account-deletion-record.ts`) and purge run.
   */
  accountId: string;
}

/**
 * The `commentversions` row that records a redaction, ready to insert.
 *
 * @param accountId - the purged suggester's `accountdeletions` row
 */
export function redactionRow(
  record: VersionRecord,
  now: Date,
  accountId: Types.ObjectId | string,
) {
  const claim: RedactionClaim = {
    format: REDACTION_FORMAT,
    versionId: String(record._id),
    originalHash: record.hash,
    remainingHash: remainingHash(record),
    removed: ['suggestedBy'],
    accountId: String(accountId),
  };
  const row = {
    _id: redactionId(record._id),
    commentId: redactionKey(record._id),
    seq: 1,
    text: JSON.stringify(claim),
    authorUserId: REDACTION_AUTHOR,
    createdAt: now,
    prevHash: GENESIS_HASH,
  };
  return {
    ...row,
    hash: computeVersionHash(
      { ...row, blockId: row.commentId },
      COMMENT_HASH_SCHEME,
    ),
  };
}

/** A stored record's claim, or undefined when it is not one. */
export function parseRedaction(text: string): RedactionClaim | undefined {
  try {
    const value = JSON.parse(text) as Partial<RedactionClaim> | null;
    return value?.format === REDACTION_FORMAT &&
      typeof value.versionId === 'string' &&
      typeof value.originalHash === 'string' &&
      typeof value.remainingHash === 'string' &&
      typeof value.accountId === 'string'
      ? (value as RedactionClaim)
      : undefined;
  } catch {
    return undefined;
  }
}
