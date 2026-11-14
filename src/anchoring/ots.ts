import { createHash } from 'node:crypto';

/**
 * The OpenTimestamps proof format (plan §6, Chunk 16), written here because
 * the reference JavaScript library is LGPL-3.0 (measured: `npm view
 * opentimestamps license`), which this repository does not take.
 *
 * Format, as the reference implementation (python-opentimestamps,
 * `core/timestamp.py`, `core/op.py`, `core/notary.py`) defines it:
 *
 * - a timestamp is a list of items; every item but the last is preceded by
 *   0xff ("fork"); an item is an attestation (0x00, an 8-byte tag, then its
 *   payload as varbytes) or an operation followed by the timestamp of its
 *   result;
 * - operations: 0x08 SHA-256, 0xf0 append(varbytes), 0xf1 prepend(varbytes);
 *   no other operation appears in calendar or Bitcoin proofs we read, and any
 *   other is refused rather than guessed;
 * - varuint: 7 bits per byte, least significant first, high bit = more;
 *   varbytes: varuint length then the bytes;
 * - a pending attestation (tag 83dfe30d2ef90c8e) carries the calendar's URI
 *   as varbytes; a Bitcoin attestation (tag 0588960d73d71901) the block
 *   height as a varuint, and its message is that block's Merkle root;
 * - a detached .ots file is the magic header, version 1, the file-hash
 *   operation (0x08 = SHA-256), the 32-byte digest, then the timestamp.
 */

const MAGIC = Buffer.from(
  '004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294',
  'hex',
);
const TAG_PENDING = '83dfe30d2ef90c8e';
const TAG_BITCOIN = '0588960d73d71901';
const OP_SHA256 = 0x08;
const OP_APPEND = 0xf0;
const OP_PREPEND = 0xf1;
/** Limits the reference client uses, so a hostile proof cannot blow up. */
const MAX_MSG = 4096;
const MAX_DEPTH = 256;

export type Attestation =
  | { kind: 'pending'; uri: string }
  | { kind: 'bitcoin'; height: number }
  | { kind: 'unknown'; tag: string; payload: Buffer };

export interface Operation {
  op: typeof OP_SHA256 | typeof OP_APPEND | typeof OP_PREPEND;
  arg?: Buffer;
}

/** A node of a proof: the message it is about, what attests it, what follows. */
export interface TimestampNode {
  msg: Buffer;
  attestations: Attestation[];
  ops: Array<{ op: Operation; child: TimestampNode }>;
}

/** A structural problem with a proof (bad bytes, an unknown operation). */
export class OtsFormatError extends Error {}

function apply(op: Operation, msg: Buffer): Buffer {
  if (op.op === OP_SHA256) return createHash('sha256').update(msg).digest();
  const result =
    op.op === OP_APPEND
      ? Buffer.concat([msg, op.arg as Buffer])
      : Buffer.concat([op.arg as Buffer, msg]);
  if (result.length > MAX_MSG) throw new OtsFormatError('message too long');
  return result;
}

class Reader {
  private at = 0;
  constructor(private readonly buf: Buffer) {}

  byte(): number {
    if (this.at >= this.buf.length) throw new OtsFormatError('truncated');
    return this.buf[this.at++];
  }

  bytes(n: number): Buffer {
    if (this.at + n > this.buf.length) throw new OtsFormatError('truncated');
    const out = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return Buffer.from(out);
  }

  varuint(): number {
    let value = 0;
    for (let shift = 0; shift <= 49; shift += 7) {
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return value;
    }
    throw new OtsFormatError('varuint too long');
  }

  varbytes(max = MAX_MSG): Buffer {
    const n = this.varuint();
    if (n > max) throw new OtsFormatError('field too long');
    return this.bytes(n);
  }

  get done() {
    return this.at === this.buf.length;
  }
}

function readAttestation(r: Reader): Attestation {
  const tag = r.bytes(8).toString('hex');
  const bytes = r.varbytes(8192);
  const payload = new Reader(bytes);
  if (tag === TAG_PENDING) {
    const uri = payload.varbytes(1000).toString('utf8');
    if (!/^[\x21-\x7e]+$/.test(uri)) {
      throw new OtsFormatError('bad calendar URI');
    }
    return { kind: 'pending', uri };
  }
  if (tag === TAG_BITCOIN)
    return { kind: 'bitcoin', height: payload.varuint() };
  return { kind: 'unknown', tag, payload: bytes };
}

function readNode(r: Reader, msg: Buffer, depth: number): TimestampNode {
  if (depth > MAX_DEPTH) throw new OtsFormatError('proof too deep');
  const node: TimestampNode = { msg, attestations: [], ops: [] };
  for (;;) {
    let tag = r.byte();
    const fork = tag === 0xff;
    if (fork) tag = r.byte();
    if (tag === 0x00) {
      node.attestations.push(readAttestation(r));
    } else if (tag === OP_SHA256) {
      const op: Operation = { op: OP_SHA256 };
      node.ops.push({ op, child: readNode(r, apply(op, msg), depth + 1) });
    } else if (tag === OP_APPEND || tag === OP_PREPEND) {
      const op: Operation = { op: tag, arg: r.varbytes() };
      node.ops.push({ op, child: readNode(r, apply(op, msg), depth + 1) });
    } else {
      throw new OtsFormatError(`unsupported operation 0x${tag.toString(16)}`);
    }
    if (!fork) return node;
  }
}

/**
 * Reads a serialized timestamp (what a calendar answers) for `msg`.
 *
 * @throws OtsFormatError on bytes that are not a whole timestamp
 */
export function parseTimestamp(bytes: Buffer, msg: Buffer): TimestampNode {
  const r = new Reader(bytes);
  const node = readNode(r, msg, 0);
  if (!r.done) throw new OtsFormatError('trailing bytes');
  return node;
}

function varuint(n: number): Buffer {
  const out: number[] = [];
  let rest = n;
  do {
    const b = rest % 128;
    rest = Math.floor(rest / 128);
    out.push(rest > 0 ? b | 0x80 : b);
  } while (rest > 0);
  return Buffer.from(out);
}

function varbytes(b: Buffer): Buffer {
  return Buffer.concat([varuint(b.length), b]);
}

function writeAttestation(a: Attestation): Buffer {
  const [tag, payload] =
    a.kind === 'pending'
      ? [TAG_PENDING, varbytes(Buffer.from(a.uri, 'utf8'))]
      : a.kind === 'bitcoin'
        ? [TAG_BITCOIN, varuint(a.height)]
        : [a.tag, a.payload];
  return Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from(tag, 'hex'),
    varbytes(payload),
  ]);
}

/** Serializes a timestamp: attestations first, then operations, in order. */
export function serializeTimestamp(node: TimestampNode): Buffer {
  const items = [
    ...node.attestations.map(writeAttestation),
    ...node.ops.map(({ op, child }) =>
      Buffer.concat([
        Buffer.from([op.op]),
        op.arg ? varbytes(op.arg) : Buffer.alloc(0),
        serializeTimestamp(child),
      ]),
    ),
  ];
  if (items.length === 0) throw new OtsFormatError('empty timestamp');
  return Buffer.concat(
    items.map((item, index) =>
      index < items.length - 1
        ? Buffer.concat([Buffer.from([0xff]), item])
        : item,
    ),
  );
}

/** Adds everything in `other` (a timestamp of the same message) to `node`. */
export function mergeInto(node: TimestampNode, other: TimestampNode): void {
  node.attestations.push(...other.attestations);
  node.ops.push(...other.ops);
}

/** Every attestation in the proof, with the message it attests. */
export function attestationsOf(
  node: TimestampNode,
): Array<{ attestation: Attestation; node: TimestampNode }> {
  return [
    ...node.attestations.map((attestation) => ({ attestation, node })),
    ...node.ops.flatMap(({ child }) => attestationsOf(child)),
  ];
}

/** A whole detached proof for a SHA-256 digest. */
export function serializeDetached(digest: Buffer, tree: TimestampNode): Buffer {
  return Buffer.concat([
    MAGIC,
    varuint(1),
    Buffer.from([OP_SHA256]),
    digest,
    serializeTimestamp(tree),
  ]);
}

/**
 * Reads a detached .ots file.
 *
 * @returns the digest it is for and its proof
 * @throws OtsFormatError if it is not a version-1 SHA-256 proof
 */
export function parseDetached(file: Buffer): {
  digest: Buffer;
  tree: TimestampNode;
} {
  const r = new Reader(file);
  if (!r.bytes(MAGIC.length).equals(MAGIC)) {
    throw new OtsFormatError('not an OpenTimestamps proof');
  }
  if (r.varuint() !== 1) throw new OtsFormatError('unknown proof version');
  if (r.byte() !== OP_SHA256) throw new OtsFormatError('not a SHA-256 proof');
  const digest = r.bytes(32);
  const rest = file.subarray(MAGIC.length + 2 + 32);
  return { digest, tree: parseTimestamp(Buffer.from(rest), digest) };
}

/** What a proof attests, for status and verification. */
export interface ProofSummary {
  /** Calendars still waiting for Bitcoin, with the commitment to ask about. */
  pending: Array<{ uri: string; commitment: string }>;
  /** Bitcoin blocks the proof reaches; `merkleRoot` as stored in the header. */
  bitcoin: Array<{ height: number; merkleRoot: string }>;
}

export function summarize(tree: TimestampNode): ProofSummary {
  const summary: ProofSummary = { pending: [], bitcoin: [] };
  for (const { attestation, node } of attestationsOf(tree)) {
    if (attestation.kind === 'pending') {
      summary.pending.push({
        uri: attestation.uri,
        commitment: node.msg.toString('hex'),
      });
    } else if (attestation.kind === 'bitcoin') {
      summary.bitcoin.push({
        height: attestation.height,
        // Bitcoin headers store the Merkle root byte-reversed.
        merkleRoot: Buffer.from(node.msg).reverse().toString('hex'),
      });
    }
  }
  return summary;
}

/** The node holding the pending attestation for this calendar commitment. */
export function nodeFor(
  tree: TimestampNode,
  commitment: string,
): TimestampNode | undefined {
  return attestationsOf(tree).find(
    ({ attestation, node }) =>
      attestation.kind === 'pending' && node.msg.toString('hex') === commitment,
  )?.node;
}
