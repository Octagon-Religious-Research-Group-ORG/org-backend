import type { Types } from 'mongoose';
import {
  canonicalVersionInput,
  COMMENT_HASH_SCHEME,
  computeVersionHash,
  type VersionHashInput,
} from '../social/version-chain';
import type { AnchoredKind } from './schemas/anchor-leaf.schema';

/** A `blockversions` or `commentversions` row, as anchoring reads it. */
export interface VersionRecord {
  _id: Types.ObjectId;
  /** `blockId` of a block version, `commentId` of a comment version. */
  key: string;
  seq: number;
  text: string;
  authorUserId: string;
  createdAt: Date;
  prevHash: string;
  hash: string;
  suggestionId?: string;
  suggestedBy?: string;
}

/** The fields each collection's rows are read with. */
export const VERSION_PROJECTION = {
  _id: 1,
  blockId: 1,
  commentId: 1,
  seq: 1,
  text: 1,
  authorUserId: 1,
  createdAt: 1,
  prevHash: 1,
  hash: 1,
  suggestionId: 1,
  suggestedBy: 1,
} as const;

/** A raw row of either collection, as read with `VERSION_PROJECTION`. */
export interface RawVersionRow extends Omit<VersionRecord, 'key'> {
  blockId?: string;
  commentId?: string;
}

export function toRecord(
  kind: AnchoredKind,
  row: RawVersionRow,
): VersionRecord {
  const { blockId, commentId, ...rest } = row;
  return { ...rest, key: String(kind === 'block' ? blockId : commentId) };
}

/** The scheme argument `computeVersionHash` takes for this kind. */
function schemeOf(kind: AnchoredKind): string | undefined {
  return kind === 'comment' ? COMMENT_HASH_SCHEME : undefined;
}

function inputOf(record: VersionRecord): VersionHashInput {
  return {
    blockId: record.key,
    seq: record.seq,
    text: record.text,
    authorUserId: record.authorUserId,
    createdAt: record.createdAt,
    prevHash: record.prevHash,
    ...(record.suggestionId !== undefined
      ? { suggestionId: record.suggestionId, suggestedBy: record.suggestedBy }
      : {}),
  };
}

/** The version's hash recomputed from its stored fields. */
export function recomputeHash(kind: AnchoredKind, record: VersionRecord) {
  return computeVersionHash(inputOf(record), schemeOf(kind));
}

/** The exact string the version's hash is the SHA-256 of. */
export function canonicalOf(kind: AnchoredKind, record: VersionRecord) {
  return canonicalVersionInput(inputOf(record), schemeOf(kind));
}
