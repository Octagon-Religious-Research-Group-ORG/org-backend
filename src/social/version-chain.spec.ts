import { createHash } from 'node:crypto';
import {
  computeVersionHash,
  GENESIS_HASH,
  type StoredVersion,
  verifyChain,
} from './version-chain';

const BLOCK = 'blk-1';

function buildChain(texts: string[]): StoredVersion[] {
  let prevHash = GENESIS_HASH;
  return texts.map((text, index) => {
    const fields = {
      blockId: BLOCK,
      seq: index + 1,
      text,
      authorUserId: 'user_a',
      createdAt: new Date(Date.UTC(2026, 9, 11, 5, 0, index)),
      prevHash,
    };
    const version = { ...fields, hash: computeVersionHash(fields) };
    prevHash = version.hash;
    return version;
  });
}

describe('computeVersionHash', () => {
  const base = {
    blockId: BLOCK,
    seq: 1,
    text: 'We are all one.',
    authorUserId: 'user_a',
    createdAt: new Date('2026-10-11T05:00:00.000Z'),
    prevHash: GENESIS_HASH,
  };

  it('is the SHA-256 of the documented canonical encoding', () => {
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          'org-blockversion-v1',
          BLOCK,
          1,
          'We are all one.',
          'user_a',
          '2026-10-11T05:00:00.000Z',
          GENESIS_HASH,
        ]),
      )
      .digest('hex');
    expect(computeVersionHash(base)).toBe(expected);
  });

  it('hashes a date read back from storage identically', () => {
    const roundTripped = new Date(base.createdAt.toISOString());
    expect(computeVersionHash({ ...base, createdAt: roundTripped })).toBe(
      computeVersionHash(base),
    );
  });

  it.each([
    ['blockId', { blockId: 'blk-2' }],
    ['seq', { seq: 2 }],
    ['text', { text: 'We are all one!' }],
    ['authorUserId', { authorUserId: 'user_b' }],
    ['createdAt', { createdAt: new Date('2026-10-11T05:00:00.001Z') }],
    ['prevHash', { prevHash: 'f'.repeat(64) }],
  ])('changes when %s changes', (_field, change) => {
    expect(computeVersionHash({ ...base, ...change })).not.toBe(
      computeVersionHash(base),
    );
  });
});

describe('verifyChain', () => {
  it('accepts an intact history in any input order', () => {
    const chain = buildChain(['one', 'two', 'three']);
    expect(verifyChain(BLOCK, [chain[2], chain[0], chain[1]])).toEqual({
      valid: true,
      length: 3,
      headHash: chain[2].hash,
    });
  });

  it('accepts an empty history as length 0', () => {
    expect(verifyChain(BLOCK, [])).toEqual({
      valid: true,
      length: 0,
      headHash: GENESIS_HASH,
    });
  });

  it('detects an edited old version', () => {
    const chain = buildChain(['one', 'two', 'three']);
    chain[1] = { ...chain[1], text: 'TWO' };
    expect(verifyChain(BLOCK, chain)).toEqual({
      valid: false,
      seq: 2,
      reason: 'hash-mismatch',
    });
  });

  it('detects an edit whose own hash was recomputed by the forger', () => {
    const chain = buildChain(['one', 'two', 'three']);
    const forged = { ...chain[1], text: 'TWO' };
    chain[1] = { ...forged, hash: computeVersionHash(forged) };
    expect(verifyChain(BLOCK, chain)).toEqual({
      valid: false,
      seq: 3,
      reason: 'broken-link',
    });
  });

  it('detects a removed middle version', () => {
    const chain = buildChain(['one', 'two', 'three']);
    expect(verifyChain(BLOCK, [chain[0], chain[2]])).toEqual({
      valid: false,
      seq: 2,
      reason: 'sequence-gap',
    });
  });

  it('detects a duplicated sequence number', () => {
    const chain = buildChain(['one', 'two']);
    expect(verifyChain(BLOCK, [chain[0], chain[0], chain[1]])).toEqual({
      valid: false,
      seq: 2,
      reason: 'sequence-gap',
    });
  });

  it('detects a version that belongs to another block', () => {
    const chain = buildChain(['one']);
    expect(verifyChain('blk-other', chain)).toEqual({
      valid: false,
      seq: 1,
      reason: 'wrong-block',
    });
  });

  it('detects a first version that does not start from the genesis hash', () => {
    const chain = buildChain(['one']);
    chain[0] = { ...chain[0], prevHash: 'a'.repeat(64) };
    expect(verifyChain(BLOCK, chain)).toEqual({
      valid: false,
      seq: 1,
      reason: 'broken-link',
    });
  });
});
