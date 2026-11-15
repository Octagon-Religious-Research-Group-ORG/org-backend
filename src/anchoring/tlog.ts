import { createHash } from 'node:crypto';

/**
 * The RFC 6962 / RFC 9162 Merkle tree of the daily anchor log (Chunk 16b).
 *
 * Unlike the per-day tree in `merkle.ts`, this one is a LOG: leaves keep
 * the order they were appended in, and the tree shape is the RFC's, so a
 * consistency proof shows that a larger tree only appended to a smaller
 * one, and anyone with any RFC 6962 library can check it:
 *
 * - leaf hash = SHA-256(0x00 || leaf data);
 * - node hash = SHA-256(0x01 || left || right);
 * - MTH of n > 1 leaves splits at k, the largest power of two below n;
 * - the empty tree's hash is SHA-256 of nothing.
 *
 * Proof generation follows RFC 6962 §2.1.1 (PATH) and §2.1.2 (PROOF /
 * SUBPROOF); verification follows RFC 9162 §2.1.3.2 and §2.1.4.2, with the
 * edge cases the Go reference library (transparency-dev/merkle) refuses
 * refused here too: an index at or past the size, a consistency proof from
 * the empty tree, a non-empty proof between equal sizes, hashes that are not
 * 32 bytes.
 */
const HASH_BYTES = 32;

export const EMPTY_ROOT = createHash('sha256').digest();

/** SHA-256(0x00 || data). */
export function logLeafHash(data: Buffer): Buffer {
  return createHash('sha256')
    .update(Buffer.from([0x00]))
    .update(data)
    .digest();
}

/** SHA-256(0x01 || left || right). */
export function logNodeHash(left: Buffer, right: Buffer): Buffer {
  return createHash('sha256')
    .update(Buffer.from([0x01]))
    .update(left)
    .update(right)
    .digest();
}

/** The largest power of two strictly below n (n > 1). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** MTH(D[n]) over leaf HASHES (RFC 6962 §2.1). */
export function treeRoot(leafHashes: readonly Buffer[]): Buffer {
  if (leafHashes.length === 0) return EMPTY_ROOT;
  if (leafHashes.length === 1) return leafHashes[0];
  const k = split(leafHashes.length);
  return logNodeHash(
    treeRoot(leafHashes.slice(0, k)),
    treeRoot(leafHashes.slice(k)),
  );
}

function path(m: number, leaves: readonly Buffer[]): Buffer[] {
  if (leaves.length <= 1) return [];
  const k = split(leaves.length);
  return m < k
    ? [...path(m, leaves.slice(0, k)), treeRoot(leaves.slice(k))]
    : [...path(m - k, leaves.slice(k)), treeRoot(leaves.slice(0, k))];
}

/**
 * The audit path of leaf `index` in the tree of these leaf hashes
 * (RFC 6962 §2.1.1 PATH).
 *
 * @throws RangeError for an index outside the tree
 */
export function inclusionProof(
  index: number,
  leafHashes: readonly Buffer[],
): Buffer[] {
  if (!Number.isInteger(index) || index < 0 || index >= leafHashes.length) {
    throw new RangeError(`no leaf ${index} in a tree of ${leafHashes.length}`);
  }
  return path(index, leafHashes);
}

function subproof(
  m: number,
  leaves: readonly Buffer[],
  complete: boolean,
): Buffer[] {
  const n = leaves.length;
  if (m === n) return complete ? [] : [treeRoot(leaves)];
  const k = split(n);
  return m <= k
    ? [...subproof(m, leaves.slice(0, k), complete), treeRoot(leaves.slice(k))]
    : [
        ...subproof(m - k, leaves.slice(k), false),
        treeRoot(leaves.slice(0, k)),
      ];
}

/**
 * The consistency proof from the tree of the first `first` leaves to the
 * tree of all of them (RFC 6962 §2.1.2 PROOF). From 0 it is empty (and
 * proves nothing: {@link verifyConsistency} refuses it).
 *
 * @throws RangeError for a first size outside 0..n
 */
export function consistencyProof(
  first: number,
  leafHashes: readonly Buffer[],
): Buffer[] {
  if (!Number.isInteger(first) || first < 0 || first > leafHashes.length) {
    throw new RangeError(
      `no tree of ${first} inside a tree of ${leafHashes.length}`,
    );
  }
  if (first === 0) return [];
  return subproof(first, leafHashes, true);
}

const isHash = (value: Buffer) => value.length === HASH_BYTES;
const isSize = (value: number) => Number.isSafeInteger(value) && value >= 0;

/**
 * RFC 9162 §2.1.3.2: does `proof` show `leafHash` at `index` in the tree of
 * `size` leaves whose root is `root`?
 */
export function verifyInclusion(
  index: number,
  size: number,
  leafHash: Buffer,
  proof: readonly Buffer[],
  root: Buffer,
): boolean {
  if (!isSize(index) || !isSize(size) || index >= size) return false;
  if (!isHash(leafHash) || !isHash(root) || !proof.every(isHash)) return false;
  let fn = BigInt(index);
  let sn = BigInt(size - 1);
  let r = leafHash;
  for (const p of proof) {
    if (sn === 0n) return false;
    if ((fn & 1n) === 1n || fn === sn) {
      r = logNodeHash(p, r);
      while ((fn & 1n) === 0n && fn !== 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else {
      r = logNodeHash(r, p);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return sn === 0n && r.equals(root);
}

/** One hashing step of an inclusion proof, for a reader to redo by hand. */
export interface InclusionStep {
  left: Buffer;
  right: Buffer;
  result: Buffer;
}

/**
 * The steps `verifyInclusion` hashes, in order, so a receipt can print one
 * command per step. The caller checks the last result against the root.
 *
 * @throws RangeError when the proof does not fit the index and size
 */
export function inclusionSteps(
  index: number,
  size: number,
  leafHash: Buffer,
  proof: readonly Buffer[],
): InclusionStep[] {
  if (!isSize(index) || !isSize(size) || index >= size) {
    throw new RangeError(`no leaf ${index} in a tree of ${size}`);
  }
  const steps: InclusionStep[] = [];
  let fn = BigInt(index);
  let sn = BigInt(size - 1);
  let r = leafHash;
  for (const p of proof) {
    if (sn === 0n) throw new RangeError('the proof is too long');
    const [left, right] = (fn & 1n) === 1n || fn === sn ? [p, r] : [r, p];
    r = logNodeHash(left, right);
    steps.push({ left, right, result: r });
    if ((fn & 1n) === 1n || fn === sn) {
      while ((fn & 1n) === 0n && fn !== 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  if (sn !== 0n) throw new RangeError('the proof is too short');
  return steps;
}

/**
 * RFC 9162 §2.1.4.2: does `proof` show the tree of `size2` leaves with root
 * `root2` only appended to the tree of `size1` leaves with root `root1`?
 */
export function verifyConsistency(
  size1: number,
  size2: number,
  root1: Buffer,
  root2: Buffer,
  proof: readonly Buffer[],
): boolean {
  if (!isSize(size1) || !isSize(size2) || size2 < size1 || size1 === 0) {
    return false;
  }
  // Equal sizes: equal roots and nothing else, whatever their length (Go).
  if (size1 === size2) return proof.length === 0 && root1.equals(root2);
  if (!isHash(root1) || !isHash(root2) || !proof.every(isHash)) return false;
  if (proof.length === 0) return false;
  // An exact power of two: the old root is the first node of the path.
  const s1 = BigInt(size1);
  const path = (s1 & (s1 - 1n)) === 0n ? [root1, ...proof] : [...proof];
  let fn = BigInt(size1 - 1);
  let sn = BigInt(size2 - 1);
  while ((fn & 1n) === 1n) {
    fn >>= 1n;
    sn >>= 1n;
  }
  let fr = path[0];
  let sr = path[0];
  for (const c of path.slice(1)) {
    if (sn === 0n) return false;
    if ((fn & 1n) === 1n || fn === sn) {
      fr = logNodeHash(c, fr);
      sr = logNodeHash(c, sr);
      while ((fn & 1n) === 0n && fn !== 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else {
      sr = logNodeHash(sr, c);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return fr.equals(root1) && sr.equals(root2) && sn === 0n;
}
