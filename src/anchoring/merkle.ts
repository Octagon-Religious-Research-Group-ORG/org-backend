import { createHash } from 'node:crypto';

/**
 * The daily anchor's Merkle tree (plan §6, Chunk 16). Named so a reader of a
 * receipt can tell which rules built it; bumped only if the rules change.
 *
 * - leaf  = SHA-256(0x00 || versionHash), versionHash as its 32 raw bytes;
 * - node  = SHA-256(0x01 || left || right);
 * - leaves are sorted by their leaf hash, ascending, as raw bytes (the same
 *   order as lowercase hex), duplicates removed;
 * - a level with an odd number of nodes carries its LAST node up unchanged
 *   (it is never paired with itself, so no two different leaf lists can give
 *   the same root, CVE-2012-2459);
 * - one leaf: the root is that leaf's hash.
 *
 * The 0x00 / 0x01 prefixes keep a leaf from ever being read as a node
 * (RFC 6962 §2.1 uses the same two prefixes for the same reason).
 */
export const MERKLE_SCHEME = 'org-anchor-merkle-v1';

const HEX_64 = /^[0-9a-f]{64}$/;

function sha256(...parts: Buffer[]): Buffer {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function bytesOf(hex: string): Buffer {
  if (!HEX_64.test(hex)) throw new Error(`Not a SHA-256 hex digest: ${hex}`);
  return Buffer.from(hex, 'hex');
}

/** @returns the leaf hash (hex) of one version hash (hex) */
export function leafHash(versionHash: string): string {
  return sha256(Buffer.from([0x00]), bytesOf(versionHash)).toString('hex');
}

/** @returns the parent (hex) of two nodes (hex), left first */
export function nodeHash(left: string, right: string): string {
  return sha256(Buffer.from([0x01]), bytesOf(left), bytesOf(right)).toString(
    'hex',
  );
}

/** One step from a node towards the root: the sibling and its side. */
export interface PathStep {
  /** Where the sibling sits: `L` means parent = node(sibling, current). */
  side: 'L' | 'R';
  hash: string;
}

export interface MerkleTree {
  root: string;
  /** Leaf hashes in tree order (sorted). */
  leaves: string[];
  /** The path of each leaf hash. */
  pathOf(leaf: string): PathStep[] | undefined;
}

/**
 * Builds the tree over the given version hashes.
 *
 * @throws Error on an empty list or a value that is not a SHA-256 hex digest
 */
export function buildTree(versionHashes: readonly string[]): MerkleTree {
  if (versionHashes.length === 0) throw new Error('No leaves to anchor.');
  const leaves = [...new Set(versionHashes.map(leafHash))].sort();
  const levels: string[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const level = levels[levels.length - 1];
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(
        i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i],
      );
    }
    levels.push(next);
  }
  const position = new Map(leaves.map((leaf, index) => [leaf, index]));
  return {
    root: levels[levels.length - 1][0],
    leaves,
    pathOf(leaf) {
      let index = position.get(leaf);
      if (index === undefined) return undefined;
      const path: PathStep[] = [];
      for (const level of levels.slice(0, -1)) {
        const sibling = index % 2 === 0 ? index + 1 : index - 1;
        // The last node of an odd level is carried up: no step.
        if (sibling < level.length) {
          path.push({
            side: index % 2 === 0 ? 'R' : 'L',
            hash: level[sibling],
          });
        }
        index = Math.floor(index / 2);
      }
      return path;
    },
  };
}

/** @returns the root a leaf and its path lead to, or undefined if malformed */
export function rootFromPath(
  leaf: string,
  path: readonly PathStep[],
): string | undefined {
  try {
    return path.reduce(
      (current, step) =>
        step.side === 'L'
          ? nodeHash(step.hash, current)
          : nodeHash(current, step.hash),
      bytesOf(leaf).toString('hex'),
    );
  } catch {
    return undefined;
  }
}
