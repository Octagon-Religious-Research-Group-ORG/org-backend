import { createHash } from 'node:crypto';
import {
  buildTree,
  leafHash,
  MERKLE_SCHEME,
  nodeHash,
  rootFromPath,
} from './merkle';

const h = (n: number) => createHash('sha256').update(`v${n}`).digest('hex');
const sha = (hex: string) =>
  createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');

describe('the anchor Merkle tree (org-anchor-merkle-v1)', () => {
  it('is named, so a receipt says which rules built it', () => {
    expect(MERKLE_SCHEME).toBe('org-anchor-merkle-v1');
  });

  it('a leaf is SHA-256(0x00 || hash) and a node SHA-256(0x01 || left || right)', () => {
    expect(leafHash(h(1))).toBe(sha(`00${h(1)}`));
    expect(nodeHash(h(1), h(2))).toBe(sha(`01${h(1)}${h(2)}`));
    // Domain separation: a leaf is never the same bytes as a node.
    expect(leafHash(h(1))).not.toBe(sha(h(1)));
  });

  it('refuses anything that is not a SHA-256 hex digest', () => {
    expect(() => leafHash('xyz')).toThrow('Not a SHA-256 hex digest');
    expect(() => nodeHash(h(1), 'AB'.repeat(32))).toThrow();
    expect(() => buildTree([])).toThrow('No leaves');
  });

  it('one leaf: the root is that leaf, and its path is empty', () => {
    const tree = buildTree([h(1)]);
    expect(tree.root).toBe(leafHash(h(1)));
    expect(tree.pathOf(leafHash(h(1)))).toEqual([]);
  });

  it('sorts leaves by their leaf hash and drops duplicates, so input order never matters', () => {
    const a = buildTree([h(1), h(2), h(3), h(2)]);
    const b = buildTree([h(3), h(2), h(1)]);
    expect(a.root).toBe(b.root);
    expect(a.leaves).toEqual([...a.leaves].sort());
    expect(a.leaves).toHaveLength(3);
  });

  it('carries the last node of an odd level up unchanged (never paired with itself)', () => {
    const tree = buildTree([h(1), h(2), h(3)]);
    const [l1, l2, l3] = tree.leaves;
    expect(tree.root).toBe(nodeHash(nodeHash(l1, l2), l3));
    // Duplicating the odd leaf would give another root (CVE-2012-2459).
    expect(tree.root).not.toBe(nodeHash(nodeHash(l1, l2), nodeHash(l3, l3)));
    expect(tree.pathOf(l3)).toEqual([{ side: 'L', hash: nodeHash(l1, l2) }]);
  });

  it('every leaf of every size leads to the root, and only to it', () => {
    for (let size = 1; size <= 17; size++) {
      const hashes = Array.from({ length: size }, (_, i) => h(i + size * 100));
      const tree = buildTree(hashes);
      for (const leaf of tree.leaves) {
        expect(rootFromPath(leaf, tree.pathOf(leaf) ?? [])).toBe(tree.root);
      }
    }
  });

  it('a changed sibling, side or leaf no longer reaches the root', () => {
    const tree = buildTree([h(1), h(2), h(3), h(4), h(5)]);
    const leaf = tree.leaves[1];
    const path = tree.pathOf(leaf) ?? [];
    expect(path.length).toBeGreaterThan(0);
    const swapped = path.map((step, i) =>
      i === 0
        ? { ...step, side: step.side === 'L' ? ('R' as const) : ('L' as const) }
        : step,
    );
    const edited = path.map((step, i) =>
      i === 0 ? { ...step, hash: h(99) } : step,
    );
    expect(rootFromPath(leaf, swapped)).not.toBe(tree.root);
    expect(rootFromPath(leaf, edited)).not.toBe(tree.root);
    expect(rootFromPath(leafHash(h(9)), path)).not.toBe(tree.root);
  });

  it('a malformed path or leaf gives no root rather than throwing', () => {
    const tree = buildTree([h(1), h(2)]);
    expect(rootFromPath('nope', [])).toBeUndefined();
    expect(
      rootFromPath(tree.leaves[0], [{ side: 'R', hash: 'zz' }]),
    ).toBeUndefined();
  });

  it('a leaf not in the tree has no path', () => {
    expect(buildTree([h(1)]).pathOf(leafHash(h(2)))).toBeUndefined();
  });
});
