import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  consistencyProof,
  EMPTY_ROOT,
  inclusionProof,
  inclusionSteps,
  logLeafHash,
  logNodeHash,
  treeRoot,
  verifyConsistency,
  verifyInclusion,
} from './tlog';

/*
 * The RFC 6962 test vectors, as used by Google's Go Merkle library
 * (https://github.com/transparency-dev/merkle, commit
 * c39fbf350a405f68571bf4c42a6a518eb0a46a4b): `testonly/constants.go`
 * (LeafInputs, RootHashes) and every probe under `testdata/inclusion` and
 * `testdata/consistency`, which `proof/verify_test.go` reads
 * (TestVerifyInclusionProbes, TestVerifyConsistencyProbes). Converted from
 * base64 to hex into `testdata/tlog-vectors.json`, nothing else changed.
 * Apache License 2.0, Copyright Google LLC.
 */
interface Vectors {
  leafInputs: string[];
  rootHashes: string[];
  inclusion: Array<{
    file: string;
    leafIdx: number;
    treeSize: number;
    root: string | null;
    leafHash: string | null;
    proof: Array<string | null>;
    wantErr: boolean;
  }>;
  consistency: Array<{
    file: string;
    size1: number;
    size2: number;
    root1: string | null;
    root2: string | null;
    proof: Array<string | null>;
    wantErr: boolean;
  }>;
}
const vectors = JSON.parse(
  readFileSync(join(__dirname, 'testdata', 'tlog-vectors.json'), 'utf8'),
) as Vectors;
const hex = (value: string | null) => Buffer.from(value ?? '', 'hex');
const leaves = vectors.leafInputs.map((input) => logLeafHash(hex(input)));

describe('tlog: RFC 6962 hashing', () => {
  it('hashes the empty tree, leaves and nodes as RFC 6962 says', () => {
    expect(EMPTY_ROOT.toString('hex')).toBe(createHash('sha256').digest('hex'));
    expect(logLeafHash(Buffer.alloc(0)).toString('hex')).toBe(
      vectors.rootHashes[1],
    );
    expect(logNodeHash(leaves[0], leaves[1]).toString('hex')).toBe(
      vectors.rootHashes[2],
    );
  });

  it('gives every published root for sizes 0 to 8', () => {
    expect(vectors.rootHashes).toHaveLength(9);
    for (let size = 0; size <= 8; size++) {
      expect(treeRoot(leaves.slice(0, size)).toString('hex')).toBe(
        vectors.rootHashes[size],
      );
    }
  });
});

describe('tlog: the Go library probes', () => {
  it('reads all 98 inclusion and 98 consistency probes', () => {
    expect(vectors.inclusion).toHaveLength(98);
    expect(vectors.consistency).toHaveLength(98);
  });

  it.each(vectors.inclusion.map((p) => [p.file, p] as const))(
    'inclusion %s',
    (_file, probe) => {
      const ok = verifyInclusion(
        probe.leafIdx,
        probe.treeSize,
        hex(probe.leafHash),
        probe.proof.map(hex),
        hex(probe.root),
      );
      expect(ok).toBe(!probe.wantErr);
    },
  );

  it.each(vectors.consistency.map((p) => [p.file, p] as const))(
    'consistency %s',
    (_file, probe) => {
      const ok = verifyConsistency(
        probe.size1,
        probe.size2,
        hex(probe.root1),
        hex(probe.root2),
        probe.proof.map(hex),
      );
      expect(ok).toBe(!probe.wantErr);
    },
  );

  it('builds exactly the proofs of every passing probe over the test leaves', () => {
    let built = 0;
    for (const probe of vectors.inclusion.filter((p) => !p.wantErr)) {
      if (probe.treeSize > leaves.length) continue;
      expect(
        inclusionProof(probe.leafIdx, leaves.slice(0, probe.treeSize)).map(
          (h) => h.toString('hex'),
        ),
      ).toEqual(probe.proof.map((h) => h ?? ''));
      built++;
    }
    for (const probe of vectors.consistency.filter((p) => !p.wantErr)) {
      if (probe.size2 > leaves.length) continue;
      expect(
        consistencyProof(probe.size1, leaves.slice(0, probe.size2)).map((h) =>
          h.toString('hex'),
        ),
      ).toEqual(probe.proof.map((h) => h ?? ''));
      built++;
    }
    expect(built).toBeGreaterThan(5);
  });
});

describe('tlog: every proof up to 33 leaves', () => {
  const many = Array.from({ length: 33 }, (_, i) =>
    logLeafHash(Buffer.from(`leaf ${i}`)),
  );

  it('proves and verifies every inclusion and consistency, and refuses a flipped bit', () => {
    for (let size = 1; size <= many.length; size++) {
      const root = treeRoot(many.slice(0, size));
      for (let index = 0; index < size; index++) {
        const proof = inclusionProof(index, many.slice(0, size));
        expect(verifyInclusion(index, size, many[index], proof, root)).toBe(
          true,
        );
        if (proof.length > 0) {
          const bad = proof.map((h) => Buffer.from(h));
          bad[0][0] ^= 1;
          expect(verifyInclusion(index, size, many[index], bad, root)).toBe(
            false,
          );
          expect(
            verifyInclusion(index, size, many[index], proof.slice(1), root),
          ).toBe(false);
        }
        expect(
          verifyInclusion(index, size, many[index], [...proof, root], root),
        ).toBe(false);
      }
      for (let first = 1; first <= size; first++) {
        const proof = consistencyProof(first, many.slice(0, size));
        const old = treeRoot(many.slice(0, first));
        expect(verifyConsistency(first, size, old, root, proof)).toBe(true);
        if (first > 0 && first < size) {
          const wrong = Buffer.from(old);
          wrong[0] ^= 1;
          expect(verifyConsistency(first, size, wrong, root, proof)).toBe(
            false,
          );
          expect(
            verifyConsistency(first, size, old, root, proof.slice(1)),
          ).toBe(false);
        }
      }
    }
  });

  it('lists the hashing steps of every proof, refusing ones that do not fit', () => {
    for (let size = 1; size <= 9; size++) {
      const root = treeRoot(many.slice(0, size));
      for (let index = 0; index < size; index++) {
        const proof = inclusionProof(index, many.slice(0, size));
        const steps = inclusionSteps(index, size, many[index], proof);
        expect(steps).toHaveLength(proof.length);
        expect((steps.at(-1)?.result ?? many[index]).equals(root)).toBe(true);
        for (const step of steps) {
          expect(logNodeHash(step.left, step.right).equals(step.result)).toBe(
            true,
          );
        }
      }
    }
    const proof = inclusionProof(1, many.slice(0, 4));
    expect(() => inclusionSteps(4, 4, many[0], proof)).toThrow(RangeError);
    expect(() => inclusionSteps(1, 4, many[1], [...proof, proof[0]])).toThrow(
      /too long/,
    );
    expect(() => inclusionSteps(1, 4, many[1], proof.slice(1))).toThrow(
      /too short/,
    );
  });

  it('refuses sizes out of order, indexes out of range and bad arguments', () => {
    const root = treeRoot(many.slice(0, 4));
    expect(() => inclusionProof(4, many.slice(0, 4))).toThrow(RangeError);
    expect(() => inclusionProof(-1, many.slice(0, 4))).toThrow(RangeError);
    expect(() => consistencyProof(5, many.slice(0, 4))).toThrow(RangeError);
    expect(() => consistencyProof(-1, many.slice(0, 4))).toThrow(RangeError);
    expect(verifyInclusion(4, 4, many[0], [], root)).toBe(false);
    expect(verifyInclusion(0, 0, many[0], [], root)).toBe(false);
    expect(verifyInclusion(0.5, 4, many[0], [], root)).toBe(false);
    expect(verifyConsistency(5, 4, root, root, [])).toBe(false);
    expect(verifyConsistency(-1, 4, root, root, [])).toBe(false);
    expect(verifyConsistency(4, 4, root, root, [])).toBe(true);
    expect(verifyConsistency(4, 4, root, root, [root])).toBe(false);
    // From the empty tree means nothing (Go: an error), and proves nothing.
    expect(verifyConsistency(0, 4, EMPTY_ROOT, root, [])).toBe(false);
    expect(consistencyProof(0, many.slice(0, 4))).toEqual([]);
    expect(verifyConsistency(2, 4, root, root, [])).toBe(false);
    expect(verifyInclusion(0, 1, Buffer.alloc(31), [], Buffer.alloc(31))).toBe(
      false,
    );
  });
});
