import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  BlockVersion,
  type BlockVersionDocument,
  MAX_BLOCK_TEXT_LENGTH,
} from './schemas/block-version.schema';
import {
  ProfileBlock,
  type ProfileBlockDocument,
} from './schemas/profile-block.schema';
import {
  type ChainVerdict,
  computeVersionHash,
  GENESIS_HASH,
  verifyChain,
} from './version-chain';

/** How many times a save retries after losing a race for the next `seq`. */
export const MAX_APPEND_ATTEMPTS = 3;

export interface AppendVersionInput {
  blockId: string;
  text: string;
  authorUserId: string;
}

/** MongoDB duplicate-key error (unique index violation). */
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * Writes and verifies block text history. The only code that creates
 * `blockversions` rows, so every version is hash-chained the same way.
 */
@Injectable()
export class BlockVersionsService {
  constructor(
    @InjectModel(BlockVersion.name)
    private readonly versionModel: Model<BlockVersionDocument>,
    @InjectModel(ProfileBlock.name)
    private readonly blockModel: Model<ProfileBlockDocument>,
  ) {}

  /**
   * Appends a new version to a block's history and makes it current.
   *
   * Race-safe: if another save takes the same `seq` first, the unique
   * (blockId, seq) index rejects this insert and it retries on top of the
   * winner, up to {@link MAX_APPEND_ATTEMPTS} times.
   *
   * @throws BadRequestException when the text is too long
   * @throws ConflictException when the block keeps changing under this save
   */
  async appendVersion(input: AppendVersionInput) {
    if (input.text.length > MAX_BLOCK_TEXT_LENGTH) {
      throw new BadRequestException(
        `A paragraph can hold at most ${MAX_BLOCK_TEXT_LENGTH} characters.`,
      );
    }

    for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt++) {
      const head = await this.versionModel
        .findOne({ blockId: input.blockId })
        .sort({ seq: -1 })
        .select({ seq: 1, hash: 1 })
        .lean()
        .exec();

      const fields = {
        blockId: input.blockId,
        seq: (head?.seq ?? 0) + 1,
        text: input.text,
        authorUserId: input.authorUserId,
        createdAt: new Date(),
        prevHash: head?.hash ?? GENESIS_HASH,
      };

      let created: BlockVersionDocument;
      try {
        created = await this.versionModel.create({
          ...fields,
          hash: computeVersionHash(fields),
        });
      } catch (error) {
        if (isDuplicateKey(error)) continue;
        throw error;
      }

      // Only ever move the pointer forward, so a slow save that finishes
      // after a newer one cannot make an older version current again.
      await this.blockModel
        .updateOne(
          { blockId: input.blockId, currentVersionSeq: { $lt: fields.seq } },
          {
            $set: {
              currentVersionId: created._id,
              currentVersionSeq: fields.seq,
            },
          },
        )
        .exec();

      return created;
    }

    throw new ConflictException(
      'This paragraph is being changed by someone else. Please try again.',
    );
  }

  /**
   * Recomputes a block's whole hash chain from the stored versions.
   * Read-only; see {@link verifyChain} for what it can and cannot detect.
   */
  async verifyBlock(blockId: string): Promise<ChainVerdict> {
    const versions = await this.versionModel
      .find({ blockId })
      .sort({ seq: 1 })
      .lean()
      .exec();
    return verifyChain(blockId, versions);
  }
}
