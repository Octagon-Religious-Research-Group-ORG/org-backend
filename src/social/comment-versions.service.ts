import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type Types } from 'mongoose';
import {
  CommentVersion,
  type CommentVersionDocument,
  MAX_COMMENT_VERSION_TEXT,
} from './schemas/comment-version.schema';
import {
  type ChainVerdict,
  COMMENT_HASH_SCHEME,
  computeVersionHash,
  GENESIS_HASH,
  toStorableText,
  verifyChain,
} from './version-chain';

/** What an edit is told when the comment moved on since it was opened. */
export const STALE_COMMENT_EDIT =
  'This comment was changed in another window. Reload to see the latest before saving.';

export interface AppendCommentVersionInput {
  commentId: string;
  text: string;
  authorUserId: string;
  /**
   * The newest `seq` the editor saw (0 for a new comment). The version lands
   * only on top of exactly that one: anything newer, or losing the race for
   * the next `seq`, refuses it, so one edit never silently replaces another.
   */
  expectedSeq: number;
}

/** A stored comment version, as the chain functions read it. */
export interface StoredCommentVersion {
  commentId: string;
  seq: number;
  text: string;
  authorUserId: string;
  createdAt: Date;
  prevHash: string;
  hash: string;
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

/** The chain functions name the chain's key `blockId`; here it is a comment. */
function asChainVersion(version: StoredCommentVersion) {
  return {
    blockId: version.commentId,
    seq: version.seq,
    text: version.text,
    authorUserId: version.authorUserId,
    createdAt: version.createdAt,
    prevHash: version.prevHash,
    hash: version.hash,
  };
}

/**
 * Writes and verifies comment history (Chunk 9). The only code that creates
 * `commentversions` rows, with the same chain rules as block versions
 * (`version-chain.ts`) under the comment hash scheme.
 */
@Injectable()
export class CommentVersionsService {
  constructor(
    @InjectModel(CommentVersion.name)
    private readonly versionModel: Model<CommentVersionDocument>,
  ) {}

  /**
   * Appends one version on top of `expectedSeq`.
   *
   * @throws BadRequestException when the text is empty or too long
   * @throws ConflictException when `expectedSeq` is no longer the newest
   *   version, including when another edit took the next `seq` first
   */
  async append(rawInput: AppendCommentVersionInput) {
    const text = toStorableText(rawInput.text);
    if (text === '' || text.length > MAX_COMMENT_VERSION_TEXT) {
      throw new BadRequestException('That comment cannot be saved.');
    }
    const head = await this.versionModel
      .findOne({ commentId: rawInput.commentId })
      .sort({ seq: -1 })
      .select({ seq: 1, hash: 1 })
      .lean()
      .exec();
    if ((head?.seq ?? 0) !== rawInput.expectedSeq) {
      throw new ConflictException(STALE_COMMENT_EDIT);
    }
    const fields = {
      commentId: rawInput.commentId,
      seq: rawInput.expectedSeq + 1,
      text,
      authorUserId: rawInput.authorUserId,
      createdAt: new Date(),
      prevHash: head?.hash ?? GENESIS_HASH,
    };
    const hash = computeVersionHash(
      { ...fields, blockId: fields.commentId },
      COMMENT_HASH_SCHEME,
    );
    try {
      await this.versionModel.create({ ...fields, hash });
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new ConflictException(STALE_COMMENT_EDIT);
      }
      throw error;
    }
    return { seq: fields.seq, createdAt: fields.createdAt };
  }

  /** The newest version of each comment; a comment with none is absent. */
  async heads(
    commentIds: readonly string[],
  ): Promise<Map<string, { seq: number; text: string; createdAt: Date }>> {
    if (commentIds.length === 0) return new Map();
    const rows = await this.versionModel
      .aggregate<{ _id: string; seq: number; text: string; createdAt: Date }>([
        { $match: { commentId: { $in: [...commentIds] } } },
        { $sort: { commentId: 1, seq: -1 } },
        {
          $group: {
            _id: '$commentId',
            seq: { $first: '$seq' },
            text: { $first: '$text' },
            createdAt: { $first: '$createdAt' },
          },
        },
      ])
      .exec();
    return new Map(
      rows.map((row) => [
        row._id,
        { seq: row.seq, text: row.text, createdAt: row.createdAt },
      ]),
    );
  }

  /** One page of a comment's versions, newest first. */
  async page(commentId: string, skip: number, limit: number) {
    return (await this.versionModel
      .find({ commentId })
      .sort({ seq: -1 })
      .skip(skip)
      .limit(limit)
      .select({ seq: 1, text: 1, createdAt: 1, hash: 1 })
      .lean()
      .exec()) as Array<{
      seq: number;
      text: string;
      createdAt: Date;
      hash: string;
    }>;
  }

  /**
   * One version with every stored field (for a receipt, Chunk 16).
   *
   * @param seq - omitted, the newest
   */
  async full(commentId: string, seq?: number) {
    return (await this.versionModel
      .findOne(seq === undefined ? { commentId } : { commentId, seq })
      .sort({ seq: -1 })
      .lean()
      .exec()) as (StoredCommentVersion & { _id: Types.ObjectId }) | null;
  }

  /** Recomputes one comment's whole chain. Read-only. */
  async verify(commentId: string): Promise<ChainVerdict> {
    const versions = (await this.versionModel
      .find({ commentId })
      .sort({ seq: 1 })
      .lean()
      .exec()) as StoredCommentVersion[];
    return verifyChain(
      commentId,
      versions.map(asChainVersion),
      COMMENT_HASH_SCHEME,
    );
  }
}
