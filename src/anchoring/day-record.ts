import { createHash } from 'node:crypto';
import { logLeafHash } from './tlog';
import type {
  AnchoredLeaf,
  TimestampAnchor,
} from './schemas/timestamp-anchor.schema';

/**
 * One leaf of the daily anchor log (Chunk 16b): the canonical record of a
 * finished day's anchor. Only hashes, counts and times, never member text or
 * any id that names a person:
 *
 * ```
 * org-anchor-day-v2
 * day 2026-11-14
 * tree org-anchor-merkle-v2
 * root <the day's Merkle root, hex>
 * leaves <how many versions it holds>
 * leafset <SHA-256 of the anchor's whole leaf list, hex>
 * appended <when this server appended it, ISO 8601 UTC>
 * ```
 *
 * An empty day reads `tree none`, `root none`, `leaves 0`, `leafset none`.
 *
 * `leafset` (review round 1, L3) binds the leaf list exactly as stored,
 * WITH each leaf's kind, version id and version hash, which the day tree's
 * root does not: the root covers only the salted leaf values, so a writer
 * could rewrite a leaf's version id, hiding an honest holder from every
 * lookup by id, without moving the root. Every line ends
 * in a newline; the leaf hash is SHA-256(0x00 || these UTF-8 bytes).
 *
 * `appended` is not about the day: it is the server's clock when the day
 * entered the log. Once published it cannot be changed, and it is what
 * lets a verifier tell "not published yet" from "left out on purpose": an
 * anchor finished before a later-appended day was published, yet missing
 * from the log, was planted (see `AnchorLogService`).
 */
export const DAY_RECORD_SCHEME = 'org-anchor-day-v2';

/**
 * A day tree's scheme as a record may carry it: the version has at most
 * three digits (review round 3, L4), so a record is small and bounded
 * whatever a database writer planted in an anchor's `scheme`.
 */
const TREE_SCHEME = /^org-anchor-merkle-v[1-9]\d{0,2}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

export interface DayRecord {
  day: string;
  /** The day tree's scheme (`org-anchor-merkle-v2`), or `none` when empty. */
  tree: string;
  /** The day's Merkle root (hex), or `none` when empty. */
  root: string;
  leaves: number;
  /** {@link leafSetHash} of the stored leaves, or `none` when empty. */
  leafset: string;
  appended: Date;
}

/**
 * SHA-256 over the leaf list, one line `kind versionId versionHash leaf`
 * per leaf, sorted, each ending in a newline. Order-free on purpose: the
 * tree sorts its leaves itself.
 *
 * The lines are INJECTIVE (one list, one byte string) only because no
 * field can hold a space or a newline: honest fields are `block`/`comment`,
 * a 24-hex ObjectId and two 64-hex hashes (review round 2, L1). A list
 * with any other field is never recorded ({@link wellFormedLeaves}).
 */
export function leafSetHash(leaves: readonly AnchoredLeaf[]): string {
  const lines = leaves
    .map(
      (leaf) =>
        `${String(leaf.kind)} ${String(leaf.versionId)} ${String(leaf.versionHash)} ${String(leaf.leaf)}\n`,
    )
    .sort();
  return createHash('sha256').update(lines.join('')).digest('hex');
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Every leaf's fields are of the honest shape, so the lines are injective. */
export function wellFormedLeaves(leaves: readonly AnchoredLeaf[]): boolean {
  return leaves.every(
    (leaf) =>
      (leaf.kind === 'block' || leaf.kind === 'comment') &&
      /^[0-9a-f]{24}$/.test(String(leaf.versionId)) &&
      HEX64.test(String(leaf.versionHash)) &&
      HEX64.test(String(leaf.leaf)),
  );
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function validDay(day: string): boolean {
  if (!DAY.test(day)) return false;
  const at = Date.parse(`${day}T00:00:00.000Z`);
  return !Number.isNaN(at) && new Date(at).toISOString().startsWith(day);
}

export function formatDayRecord(record: DayRecord): string {
  return [
    DAY_RECORD_SCHEME,
    `day ${record.day}`,
    `tree ${record.tree}`,
    `root ${record.root}`,
    `leaves ${record.leaves}`,
    `leafset ${record.leafset}`,
    `appended ${record.appended.toISOString()}`,
    '',
  ].join('\n');
}

/** The log leaf hash of a record's text. */
export function dayRecordHash(text: string): Buffer {
  return logLeafHash(Buffer.from(text, 'utf8'));
}

/** Reads a record, or undefined unless it is exactly canonical. */
export function parseDayRecord(text: string): DayRecord | undefined {
  const match =
    /^org-anchor-day-v2\nday (\S+)\ntree (none|org-anchor-merkle-v[1-9]\d{0,2})\nroot (none|[0-9a-f]{64})\nleaves (0|[1-9]\d{0,15})\nleafset (none|[0-9a-f]{64})\nappended (\S+)\n$/.exec(
      text,
    );
  if (!match) return undefined;
  const [, day, tree, root, count, leafset, appended] = match;
  const leaves = Number(count);
  const empty = tree === 'none';
  if (
    !validDay(day) ||
    !Number.isSafeInteger(leaves) ||
    !ISO.test(appended) ||
    Number.isNaN(Date.parse(appended)) ||
    new Date(appended).toISOString() !== appended ||
    empty !== (root === 'none') ||
    empty !== (leaves === 0) ||
    empty !== (leafset === 'none')
  ) {
    return undefined;
  }
  return { day, tree, root, leaves, leafset, appended: new Date(appended) };
}

type AnchorFields = Pick<
  TimestampAnchor,
  '_id' | 'status' | 'scheme' | 'merkleRoot' | 'leafCount' | 'leaves'
>;

/**
 * The record a finished anchor gives (its leaves read with it), or
 * undefined for one that is not finished, lacks its root, scheme or count
 * (or holds a root that is not 64 hex digits, or an unbounded scheme: L4),
 * or whose leaf list does not hold that count (an edited row: it never
 * enters the log, and its own checks fail).
 */
export function recordOfAnchor(
  anchor: AnchorFields,
  appended: Date,
): DayRecord | undefined {
  if (!validDay(anchor._id)) return undefined;
  if (anchor.status === 'empty') {
    return {
      day: anchor._id,
      tree: 'none',
      root: 'none',
      leaves: 0,
      leafset: 'none',
      appended,
    };
  }
  if (
    anchor.status !== 'built' ||
    typeof anchor.scheme !== 'string' ||
    !TREE_SCHEME.test(anchor.scheme) ||
    typeof anchor.merkleRoot !== 'string' ||
    !HEX_64.test(anchor.merkleRoot) ||
    typeof anchor.leafCount !== 'number' ||
    !Array.isArray(anchor.leaves) ||
    anchor.leaves.length !== anchor.leafCount ||
    !wellFormedLeaves(anchor.leaves)
  ) {
    return undefined;
  }
  return {
    day: anchor._id,
    tree: anchor.scheme,
    root: anchor.merkleRoot,
    leaves: anchor.leafCount,
    leafset: leafSetHash(anchor.leaves),
    appended,
  };
}

/**
 * Does the anchor row still give this record's day, tree, root and count?
 * The leaf set is checked where the leaves are read (review round 2, M2).
 */
export function matchesHead(record: DayRecord, anchor: AnchorFields): boolean {
  if (anchor._id !== record.day) return false;
  if (anchor.status === 'empty') return record.tree === 'none';
  return (
    anchor.status === 'built' &&
    anchor.scheme === record.tree &&
    anchor.merkleRoot === record.root &&
    anchor.leafCount === record.leaves
  );
}

/** Does the anchor row still give this record (its append time aside)? */
export function matchesAnchor(record: DayRecord, anchor: AnchorFields) {
  const now = recordOfAnchor(anchor, record.appended);
  return now !== undefined && formatDayRecord(now) === formatDayRecord(record);
}
