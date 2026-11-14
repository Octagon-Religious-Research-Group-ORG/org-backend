import type { Types } from 'mongoose';
import {
  COMMENT_HASH_SCHEME,
  computeVersionHash,
  GENESIS_HASH,
} from '../social/version-chain';

/**
 * An account-deletion record (Chunk 17 review round 4, #2): written,
 * append-only, by the verified `user.deleted` webhook in the same
 * transaction that first inserts the account's `accountdeletions` row. It
 * names that row's id, the deletion time and the sorted ids of the comments
 * the account had authored at that moment. Ids only, never the Clerk id.
 *
 * Like a redaction record it is a reserved comment-version chain,
 * `account-deleted:<accountRowId>`, so the existing daily anchor takes it
 * unchanged. A long list is split over several versions of the chain
 * ({@link ACCOUNT_DELETED_PART_SIZE} ids each), linked by `prevHash` like any
 * chain, so no version outgrows the comment-version text limit. No comment
 * row has that id, so no thread, export or search ever shows it.
 *
 * Five years later a redaction record must name this record's account, and
 * the suggestion it redacts must be in this anchored list. A forged
 * `accountdeletions` row has no such record anchored years before, so the
 * redaction it tries to support FAILS.
 */
export const ACCOUNT_DELETED_FORMAT = 'org-account-deleted-v1';
export const ACCOUNT_DELETED_PREFIX = 'account-deleted:';
/** The webhook as the record's author (not a person). */
export const ACCOUNT_DELETED_AUTHOR = 'system:account-deletion';
/** Comment ids per version of the chain (a UUID is 36 characters). */
export const ACCOUNT_DELETED_PART_SIZE = 250;

export function accountDeletedKey(accountId: Types.ObjectId | string): string {
  return `${ACCOUNT_DELETED_PREFIX}${String(accountId)}`;
}

export interface AccountDeletedClaim {
  format: string;
  accountId: string;
  deletedAt: string;
  /** 1-based, and equal to the version's `seq`. */
  part: number;
  parts: number;
  commentIds: string[];
}

/** The `commentversions` rows of one account deletion, ready to insert. */
export function accountDeletedRows(
  accountId: Types.ObjectId | string,
  deletedAt: Date,
  commentIds: readonly string[],
) {
  const sorted = [...new Set(commentIds)].sort();
  const chunks: string[][] = [];
  for (let i = 0; i < sorted.length; i += ACCOUNT_DELETED_PART_SIZE) {
    chunks.push(sorted.slice(i, i + ACCOUNT_DELETED_PART_SIZE));
  }
  if (chunks.length === 0) chunks.push([]);
  const commentId = accountDeletedKey(accountId);
  const rows: Array<{
    commentId: string;
    seq: number;
    text: string;
    authorUserId: string;
    createdAt: Date;
    prevHash: string;
    hash: string;
  }> = [];
  let prevHash = GENESIS_HASH;
  chunks.forEach((ids, index) => {
    const claim: AccountDeletedClaim = {
      format: ACCOUNT_DELETED_FORMAT,
      accountId: String(accountId),
      deletedAt: deletedAt.toISOString(),
      part: index + 1,
      parts: chunks.length,
      commentIds: ids,
    };
    const row = {
      commentId,
      seq: index + 1,
      text: JSON.stringify(claim),
      authorUserId: ACCOUNT_DELETED_AUTHOR,
      createdAt: deletedAt,
      prevHash,
    };
    const hash = computeVersionHash(
      { ...row, blockId: row.commentId },
      COMMENT_HASH_SCHEME,
    );
    rows.push({ ...row, hash });
    prevHash = hash;
  });
  return rows;
}

/** A stored record's claim, or undefined when it is not one. */
export function parseAccountDeleted(
  text: string,
): AccountDeletedClaim | undefined {
  try {
    const value = JSON.parse(text) as Partial<AccountDeletedClaim> | null;
    return value?.format === ACCOUNT_DELETED_FORMAT &&
      typeof value.accountId === 'string' &&
      typeof value.deletedAt === 'string' &&
      Number.isInteger(value.part) &&
      Number.isInteger(value.parts) &&
      Array.isArray(value.commentIds) &&
      value.commentIds.every((id) => typeof id === 'string')
      ? (value as AccountDeletedClaim)
      : undefined;
  } catch {
    return undefined;
  }
}
