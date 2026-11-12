import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  BlockVersion,
  type BlockVersionDocument,
  EMPTY_BLOCK_TEXT_REFUSAL,
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
  toStorableText,
  verifyChain,
} from './version-chain';

/** How many times a save retries after losing a race for the next `seq`. */
export const MAX_APPEND_ATTEMPTS = 3;

/** What an edit is told when the text moved on since the editor opened it. */
export const STALE_EDIT_REFUSAL =
  'This was changed in another window. Reload to see the latest before saving.';

export interface AppendVersionInput {
  blockId: string;
  text: string;
  authorUserId: string;
  /**
   * The newest `seq` the editor saw (0 for a block with no versions). When
   * given, the save lands only on top of exactly that version: anything newer,
   * or losing the race for the next `seq`, refuses it instead of retrying, so
   * one save can never silently overwrite another.
   */
  expectedSeq?: number;
  /** When the text is a member's accepted rewording suggestion (Chunk 9). */
  origin?: VersionOrigin;
}

/** Where a version's text came from, when not from its author alone. */
export interface VersionOrigin {
  /** The suggestion's comment id. */
  suggestionId: string;
  /** Its author's Clerk user id. */
  suggestedBy: string;
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
  private readonly logger = new Logger(BlockVersionsService.name);

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
   * @throws BadRequestException when the text is empty or too long
   * @throws NotFoundException when the block does not exist
   * @throws ConflictException when the block keeps changing under this save,
   *   or, with `expectedSeq`, when that is no longer the newest version
   */
  async appendVersion(rawInput: AppendVersionInput) {
    const input = { ...rawInput, text: toStorableText(rawInput.text) };
    if (input.text.length > MAX_BLOCK_TEXT_LENGTH) {
      throw new BadRequestException(
        `A paragraph can hold at most ${MAX_BLOCK_TEXT_LENGTH} characters.`,
      );
    }
    if (input.text === '') {
      throw new BadRequestException(EMPTY_BLOCK_TEXT_REFUSAL);
    }
    // Checked first because a version row can never be taken back, and the
    // pointer update below cannot tell: matching nothing is also what a slow
    // save does when a newer version already moved the pointer.
    if ((await this.blockModel.exists({ blockId: input.blockId })) === null) {
      throw new NotFoundException('That paragraph does not exist.');
    }

    for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt++) {
      const head = await this.versionModel
        .findOne({ blockId: input.blockId })
        .sort({ seq: -1 })
        .select({ seq: 1, hash: 1 })
        .lean()
        .exec();
      if (
        input.expectedSeq !== undefined &&
        (head?.seq ?? 0) !== input.expectedSeq
      ) {
        throw new ConflictException(STALE_EDIT_REFUSAL);
      }

      const fields = {
        blockId: input.blockId,
        seq: (head?.seq ?? 0) + 1,
        text: input.text,
        authorUserId: input.authorUserId,
        createdAt: new Date(),
        prevHash: head?.hash ?? GENESIS_HASH,
        ...(input.origin
          ? {
              suggestionId: input.origin.suggestionId,
              suggestedBy: input.origin.suggestedBy,
            }
          : {}),
      };

      let created: BlockVersionDocument;
      try {
        created = await this.versionModel.create({
          ...fields,
          hash: computeVersionHash(fields),
        });
      } catch (error) {
        if (isDuplicateKey(error)) {
          if (input.expectedSeq !== undefined) {
            throw new ConflictException(STALE_EDIT_REFUSAL);
          }
          continue;
        }
        throw error;
      }

      // Only ever move the pointer forward, so a slow save that finishes
      // after a newer one cannot make an older version current again. The
      // version is the record and readers follow the newest one, so a
      // pointer left behind is logged, never reported as a failed save; the
      // next save moves it forward, and verifyBlock reports it meanwhile.
      await this.movePointer(input.blockId, created._id, fields.seq);
      return created;
    }

    throw new ConflictException(
      'This paragraph is being changed by someone else. Please try again.',
    );
  }

  private async movePointer(blockId: string, versionId: unknown, seq: number) {
    try {
      await this.blockModel
        .updateOne(
          { blockId, currentVersionSeq: { $lt: seq } },
          { $set: { currentVersionId: versionId, currentVersionSeq: seq } },
        )
        .exec();
    } catch (error) {
      this.logger.warn(
        `Version ${seq} of ${blockId} is saved, but its pointer was not moved: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Recomputes a block's whole hash chain and compares its head with the
   * block's `currentVersionSeq`, which is what catches removed newest versions.
   * Read-only; see {@link verifyChain} for what it can and cannot detect.
   *
   * The block is read before the versions on purpose: a save landing between
   * the two reads can then only look like `pointer-behind`, never `truncated`.
   *
   * @returns a failure for a block with no versions, since every block is
   *   written with its first version.
   */
  async verifyBlock(blockId: string): Promise<ChainVerdict> {
    const block = await this.blockModel
      .findOne({ blockId })
      .select({ currentVersionSeq: 1 })
      .lean()
      .exec();
    const versions = await this.versionModel
      .find({ blockId })
      .sort({ seq: 1 })
      .lean()
      .exec();

    const verdict = verifyChain(blockId, versions);
    if (!verdict.valid) return verdict;
    if (verdict.length === 0) {
      return { valid: false, seq: 0, reason: 'no-versions' };
    }
    if (!block) {
      return { valid: false, seq: verdict.length, reason: 'missing-block' };
    }
    if (block.currentVersionSeq > verdict.length) {
      return {
        valid: false,
        seq: block.currentVersionSeq,
        reason: 'truncated',
      };
    }
    if (block.currentVersionSeq !== verdict.length) {
      return { valid: false, seq: verdict.length, reason: 'pointer-behind' };
    }
    return verdict;
  }
}
