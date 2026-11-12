import { createHash } from 'node:crypto';
import {
  COMMENT_HASH_SCHEME,
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

describe('verifyChain on a row whose types were tampered with', () => {
  it.each([
    ['a string', '2026-10-11T05:00:00.000Z'],
    ['missing', undefined],
    ['an invalid date', new Date('not a date')],
    ['a number', 1760158800000],
  ])('names the row when createdAt is %s', (_label, createdAt) => {
    const chain = buildChain(['one', 'two']);
    const tampered = [
      chain[0],
      { ...chain[1], createdAt } as unknown as StoredVersion,
    ];
    expect(verifyChain(BLOCK, tampered)).toEqual({
      valid: false,
      seq: 2,
      reason: 'invalid-field',
    });
  });

  it('does not crash on a missing or string sequence number', () => {
    const chain = buildChain(['one']);
    for (const seq of [undefined, '1']) {
      const tampered = [{ ...chain[0], seq } as unknown as StoredVersion];
      expect(verifyChain(BLOCK, tampered)).toMatchObject({
        valid: false,
        reason: 'sequence-gap',
      });
    }
  });
});

describe('hash schemes (Chunk 9)', () => {
  const base = {
    blockId: BLOCK,
    seq: 2,
    text: 'Suggested wording.',
    authorUserId: 'user_owner',
    createdAt: new Date('2026-11-12T05:00:00.000Z'),
    prevHash: GENESIS_HASH,
  };

  it('keeps every existing block hash: no origin, same digest as before', () => {
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          'org-blockversion-v1',
          BLOCK,
          2,
          'Suggested wording.',
          'user_owner',
          '2026-11-12T05:00:00.000Z',
          GENESIS_HASH,
        ]),
        'utf8',
      )
      .digest('hex');
    expect(computeVersionHash(base)).toBe(expected);
  });

  it('commits an accepted suggestion and its author, under their own scheme', () => {
    const suggested = { ...base, suggestionId: 'cmt_1', suggestedBy: 'user_s' };
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          'org-blockversion-v2-suggestion',
          BLOCK,
          2,
          'Suggested wording.',
          'user_owner',
          '2026-11-12T05:00:00.000Z',
          GENESIS_HASH,
          'cmt_1',
          'user_s',
        ]),
        'utf8',
      )
      .digest('hex');
    expect(computeVersionHash(suggested)).toBe(expected);
    expect(
      computeVersionHash({ ...suggested, suggestedBy: 'user_t' }),
    ).not.toBe(expected);
    expect(computeVersionHash({ ...base, suggestionId: 'cmt_1' })).not.toBe(
      expected,
    );
  });

  it('never hashes a comment version like a block version', () => {
    const comment = computeVersionHash(base, COMMENT_HASH_SCHEME);
    expect(comment).not.toBe(computeVersionHash(base));
    // A suggestion origin is a block-version field only.
    expect(
      computeVersionHash({ ...base, suggestionId: 'x' }, COMMENT_HASH_SCHEME),
    ).toBe(comment);
    const chain = [{ ...base, seq: 1, hash: '' }];
    chain[0].hash = computeVersionHash(chain[0], COMMENT_HASH_SCHEME);
    expect(verifyChain(BLOCK, chain, COMMENT_HASH_SCHEME)).toMatchObject({
      valid: true,
    });
    expect(verifyChain(BLOCK, chain)).toMatchObject({
      valid: false,
      reason: 'hash-mismatch',
    });
  });
});
