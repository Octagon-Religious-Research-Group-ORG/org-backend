import type { Model } from 'mongoose';
import type { BlockVersionDocument } from './schemas/block-version.schema';

/** The newest version of one block. */
export interface VersionHead {
  seq: number;
  text: string;
}

/**
 * The newest version of each block, read from the versions themselves.
 *
 * A version is the record. The block's pointer (`currentVersionId`) is moved
 * after the version is written, by a separate update that can fail; reading
 * the pointer would then show the older text while a newer version exists,
 * and an "unchanged" save of the old text would keep the newer one hidden
 * (Chunk 8 review, N-3). The unique (blockId, seq) index serves this query.
 *
 * @returns a map from blockId to its head; a block with no version is absent
 */
export async function readHeads(
  versionModel: Model<BlockVersionDocument>,
  blockIds: readonly string[],
): Promise<Map<string, VersionHead>> {
  if (blockIds.length === 0) return new Map();
  const heads = await versionModel
    .aggregate<{ _id: string; seq: number; text: string }>([
      { $match: { blockId: { $in: [...blockIds] } } },
      { $sort: { blockId: 1, seq: -1 } },
      {
        $group: {
          _id: '$blockId',
          seq: { $first: '$seq' },
          text: { $first: '$text' },
        },
      },
    ])
    .exec();
  return new Map(
    heads.map((head) => [head._id, { seq: head.seq, text: head.text }]),
  );
}
