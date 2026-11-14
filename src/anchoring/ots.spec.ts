import { createHash } from 'node:crypto';
import {
  attestationsOf,
  mergeInto,
  nodeFor,
  OtsFormatError,
  parseDetached,
  parseTimestamp,
  serializeDetached,
  serializeTimestamp,
  summarize,
  type TimestampNode,
} from './ots';
import {
  ALICE_COMMITMENT,
  ALICE_UPGRADE,
  CALENDAR_RESPONSES,
  STEP0_DIGEST,
  STEP0_OTS_FILE,
} from './step0-fixtures.mocks-spec';

const DIGEST = Buffer.from(STEP0_DIGEST, 'hex');
const MAGIC = STEP0_OTS_FILE.subarray(0, 31);
const sha = (b: Buffer) => createHash('sha256').update(b).digest();

/** A Bitcoin attestation subtree (synthetic: no real block is claimed). */
function bitcoinUpgrade(height: number): Buffer {
  // sha256, then attestation 0588960d73d71901 with varuint height.
  const payload: number[] = [];
  let rest = height;
  do {
    const b = rest % 128;
    rest = Math.floor(rest / 128);
    payload.push(rest > 0 ? b | 0x80 : b);
  } while (rest > 0);
  return Buffer.concat([
    Buffer.from([0x08, 0x00]),
    Buffer.from('0588960d73d71901', 'hex'),
    Buffer.from([payload.length, ...payload]),
  ]);
}

describe('OpenTimestamps proofs, with the REAL Step 0 calendar answers', () => {
  it('reads the four calendars as pending attestations for the Step 0 digest', () => {
    const { digest, tree } = parseDetached(STEP0_OTS_FILE);
    expect(digest.toString('hex')).toBe(STEP0_DIGEST);
    const { pending, bitcoin } = summarize(tree);
    expect(bitcoin).toEqual([]);
    // Same URIs and commitments as the reference client's `ots info`.
    expect(pending).toEqual([
      {
        uri: 'https://alice.btc.calendar.opentimestamps.org',
        commitment:
          '6af7fef7a242f31a619a1f27ff0bac64023ad1d87adb81fd307501f884b982be2845d9a61dc3a61121d9366a',
      },
      {
        uri: 'https://bob.btc.calendar.opentimestamps.org',
        commitment:
          '6af7fef8f95c07b83f73d805c3e74d25b06889a2c94ffcbe94b7296d8d835f3d25f6c1a826ad601b27c2a4ae',
      },
      {
        uri: 'https://finney.calendar.eternitywall.com',
        commitment:
          '6af7fefa9b5b377fe2ceb146087d1a565e31fbef9d6cf1992062cafb5f9b3402bda25896571cec63d374366a',
      },
      {
        uri: 'https://btc.calendar.catallaxy.com',
        commitment:
          '6af7fefb2bbdeea58b19d7d3bc763bc8c3b514f52391428c219a16b1118666cb4c1c40285d12a422a8854b89',
      },
    ]);
  });

  it('merging the four answers rebuilds the reference file byte for byte', () => {
    const tree: TimestampNode = { msg: DIGEST, attestations: [], ops: [] };
    for (const answer of Object.values(CALENDAR_RESPONSES)) {
      mergeInto(tree, parseTimestamp(answer, DIGEST));
    }
    expect(serializeDetached(DIGEST, tree).equals(STEP0_OTS_FILE)).toBe(true);
  });

  it('a calendar answer works for any digest, as a calendar would answer it', () => {
    const other = sha(Buffer.from('another root'));
    const tree = parseTimestamp(
      CALENDAR_RESPONSES['https://a.pool.opentimestamps.org'],
      other,
    );
    const [entry] = summarize(tree).pending;
    expect(entry.uri).toBe('https://alice.btc.calendar.opentimestamps.org');
    expect(entry.commitment).not.toContain(STEP0_DIGEST);
  });

  it('an upgrade merged at its commitment makes the proof reach Bitcoin', () => {
    const { tree } = parseDetached(STEP0_OTS_FILE);
    const [first] = summarize(tree).pending;
    const node = nodeFor(tree, first.commitment) as TimestampNode;
    mergeInto(node, parseTimestamp(bitcoinUpgrade(870_123), node.msg));
    const reread = parseDetached(serializeDetached(DIGEST, tree)).tree;
    const { bitcoin, pending } = summarize(reread);
    expect(pending).toHaveLength(4);
    expect(bitcoin).toEqual([
      {
        height: 870_123,
        merkleRoot: Buffer.from(sha(node.msg)).reverse().toString('hex'),
      },
    ]);
    expect(nodeFor(tree, 'ab')).toBeUndefined();
  });

  it('reads the REAL upgrade into Bitcoin block 975755, with that block’s Merkle root', () => {
    const { tree } = parseDetached(STEP0_OTS_FILE);
    const node = nodeFor(tree, ALICE_COMMITMENT) as TimestampNode;
    mergeInto(node, parseTimestamp(ALICE_UPGRADE, node.msg));
    const reread = parseDetached(serializeDetached(DIGEST, tree));
    expect(reread.digest.toString('hex')).toBe(STEP0_DIGEST);
    // As blockstream.info shows block 975755's header.
    expect(summarize(reread.tree).bitcoin).toEqual([
      {
        height: 975_755,
        merkleRoot:
          'c484ebc9efc5042d810aa847b06f377d035a79e3b1eb2bb518fcc737de0500d9',
      },
    ]);
  });

  it('keeps an attestation it does not know, unchanged', () => {
    const unknown = Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from('1122334455667788', 'hex'),
      Buffer.from([0x02, 0xaa, 0xbb]),
    ]);
    const tree = parseTimestamp(unknown, DIGEST);
    expect(attestationsOf(tree)[0].attestation).toEqual({
      kind: 'unknown',
      tag: '1122334455667788',
      payload: Buffer.from([0xaa, 0xbb]),
    });
    expect(serializeTimestamp(tree).equals(unknown)).toBe(true);
    expect(summarize(tree)).toEqual({ pending: [], bitcoin: [] });
  });
});

describe('refusing what is not a proof', () => {
  const body = CALENDAR_RESPONSES['https://ots.btc.catallaxy.com'];
  const detached = (rest: Buffer) => Buffer.concat([MAGIC, rest]);

  it.each<[string, Buffer, string]>([
    [
      'another file',
      Buffer.from('not a proof at all, but long enough to read'),
      'not an OpenTimestamps proof',
    ],
    ['another version', detached(Buffer.from([0x02])), 'unknown proof version'],
    [
      'another file hash',
      detached(Buffer.from([0x01, 0x02])),
      'not a SHA-256 proof',
    ],
    [
      'a truncated digest',
      detached(Buffer.from([0x01, 0x08, 0x01])),
      'truncated',
    ],
  ])('a detached file with %s', (_, file, message) => {
    expect(() => parseDetached(file)).toThrow(message);
  });

  it.each<[string, Buffer, string]>([
    ['nothing', Buffer.alloc(0), 'truncated'],
    [
      'trailing bytes',
      Buffer.concat([body, Buffer.from([0x00])]),
      'trailing bytes',
    ],
    [
      'an operation we do not take',
      Buffer.from([0x02]),
      'unsupported operation 0x2',
    ],
    [
      'a varuint without end',
      Buffer.from([0xf0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      'varuint too long',
    ],
    ['a field too long', Buffer.from([0xf0, 0x81, 0x40]), 'field too long'],
    [
      'a calendar URI that is not printable',
      Buffer.from('0083dfe30d2ef90c8e0302012001', 'hex'),
      'bad calendar URI',
    ],
  ])('a timestamp of %s', (_, bytes, message) => {
    expect(() => parseTimestamp(bytes, DIGEST)).toThrow(message);
    expect(() => parseTimestamp(bytes, DIGEST)).toThrow(OtsFormatError);
  });

  it('a message grown past 4096 bytes', () => {
    const append = Buffer.concat([
      Buffer.from([0xf0, 0x80, 0x20]),
      Buffer.alloc(4096),
    ]);
    expect(() => parseTimestamp(append, DIGEST)).toThrow('message too long');
    const prepend = Buffer.concat([
      Buffer.from([0xf1, 0x80, 0x20]),
      Buffer.alloc(4096),
    ]);
    expect(() => parseTimestamp(prepend, DIGEST)).toThrow('message too long');
  });

  it('a proof nested deeper than the reference limit', () => {
    expect(() => parseTimestamp(Buffer.alloc(300, 0x08), DIGEST)).toThrow(
      'proof too deep',
    );
  });

  it('an empty timestamp cannot be written', () => {
    expect(() =>
      serializeTimestamp({ msg: DIGEST, attestations: [], ops: [] }),
    ).toThrow('empty timestamp');
  });
});
