import { createHash } from 'node:crypto';
import { types } from 'node:util';

/** `prevHash` of the first version of every block. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Bumped only if the hashed fields ever change. Stored implicitly in every hash,
 * so old and new versions can never be confused with each other.
 */
const HASH_SCHEME = 'org-blockversion-v1';

/** The fields of a block version that its hash commits to. */
export interface VersionHashInput {
  blockId: string;
  seq: number;
  text: string;
  authorUserId: string;
  createdAt: Date;
  prevHash: string;
}

/** A stored version, as read back for verification. */
export interface StoredVersion extends VersionHashInput {
  hash: string;
}

/**
 * Replaces each lone surrogate with U+FFFD, which is what BSON stores for one.
 *
 * `JSON.stringify` hashes a lone surrogate as the escape `\ud83d`, while the
 * database keeps U+FFFD, so a version hashed from the raw text could never
 * verify again. Well-formed text comes back unchanged, so no existing hash
 * moves. Everything that appends a version must pass its text through here.
 */
export function toStorableText(text: string): string {
  return text.replace(/\p{Cs}/gu, '�');
}

/**
 * SHA-256 over a canonical encoding of a version.
 *
 * A JSON array (not an object) is used so field order is fixed by position and
 * no serializer can reorder keys. `createdAt` is encoded as ISO-8601 UTC with
 * milliseconds, which is exactly what MongoDB stores, so a value read back from
 * the database hashes identically.
 *
 * @returns lowercase hex digest
 */
export function computeVersionHash(input: VersionHashInput): string {
  const canonical = JSON.stringify([
    HASH_SCHEME,
    input.blockId,
    input.seq,
    input.text,
    input.authorUserId,
    input.createdAt.toISOString(),
    input.prevHash,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export type ChainVerdict =
  | { valid: true; length: number; headHash: string }
  | {
      valid: false;
      seq: number;
      reason:
        | 'sequence-gap'
        | 'wrong-block'
        | 'broken-link'
        | 'hash-mismatch'
        | 'invalid-field'
        // From verifyBlock, which also compares the chain with its block row:
        | 'no-versions'
        | 'missing-block'
        | 'truncated'
        | 'pointer-behind';
    };

/** A real, valid Date; a raw write can leave a string or nothing here. */
function isValidDate(value: unknown): value is Date {
  return types.isDate(value) && !Number.isNaN(value.getTime());
}

/**
 * Checks one block's version history end to end.
 *
 * Detects an edited version (its hash no longer matches), a removed or
 * inserted version (sequence gap or broken `prevHash` link), a version moved
 * from another block, and a row whose types were tampered with. Removing only
 * the NEWEST version leaves a valid shorter chain; `verifyBlock` catches that
 * by comparing the head with the block's `currentVersionSeq`.
 *
 * The hash is unkeyed and no external anchor exists yet (plan §6), so this
 * finds accidents and partial edits only: someone able to write the database
 * can recompute every hash and the pointer, and nothing here would notice.
 *
 * @param blockId - the block the versions must belong to
 * @param versions - every stored version of the block, in any order
 * @returns `valid: true` with the chain length and head hash, or the first
 *   failing sequence number and why it failed. An empty history is valid with
 *   length 0; whether a block may have no versions is the caller's decision.
 */
export function verifyChain(
  blockId: string,
  versions: readonly StoredVersion[],
): ChainVerdict {
  const ordered = [...versions].sort((a, b) => a.seq - b.seq);
  let prevHash = GENESIS_HASH;

  for (const [index, version] of ordered.entries()) {
    const expectedSeq = index + 1;
    if (version.seq !== expectedSeq) {
      return { valid: false, seq: expectedSeq, reason: 'sequence-gap' };
    }
    if (version.blockId !== blockId) {
      return { valid: false, seq: version.seq, reason: 'wrong-block' };
    }
    if (version.prevHash !== prevHash) {
      return { valid: false, seq: version.seq, reason: 'broken-link' };
    }
    if (!isValidDate(version.createdAt)) {
      return { valid: false, seq: version.seq, reason: 'invalid-field' };
    }
    if (computeVersionHash(version) !== version.hash) {
      return { valid: false, seq: version.seq, reason: 'hash-mismatch' };
    }
    prevHash = version.hash;
  }

  return { valid: true, length: ordered.length, headHash: prevHash };
}
