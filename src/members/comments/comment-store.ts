import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type Types } from 'mongoose';
import {
  Comment,
  type CommentDocument,
} from '../../social/schemas/comment.schema';
import type { CommentRow } from './comment-serializers';
import {
  MAX_THREAD_DEPTH,
  PAGE_THREAD,
  visibleCounts,
} from './comment-threads';
import type { CommentSkeleton } from './comment-threads';
import { describeFailure, THREAD_PAGE_SIZE } from './comment-limits';

/**
 * How long an edit's turn on a comment, or an unconfirmed new comment, is
 * trusted. Past it, the writer is taken to have died.
 */
export const COMMENT_TURN_STALE_MS = 5 * 60_000;

/**
 * Rows a reader can see at all. A site comment is written in three steps:
 * its row (without `bodySeq`), its first version, then `bodySeq` on the row.
 * Until that last step it is listed, counted and answered nowhere, so a
 * failure part-way never shows a comment with no recorded text, and never
 * leaves a recorded text without its comment (`repairUnconfirmed`).
 */
export const LISTED = {
  $or: [{ source: 'migrated' as const }, { bodySeq: { $exists: true } }],
};

/** The comment row fields any answer is built from. */
export const COMMENT_FIELDS = {
  commentId: 1,
  profileId: 1,
  tabId: 1,
  parentCommentId: 1,
  authorUserId: 1,
  legacyAuthorName: 1,
  legacyCreatedAt: 1,
  anchorText: 1,
  body: 1,
  bodySeq: 1,
  source: 1,
  kind: 1,
  writtenAsAdmin: 1,
  createdAt: 1,
  removedAt: 1,
  suggestion: 1,
};

export type StoredComment = CommentRow & {
  _id: Types.ObjectId;
  profileId: Types.ObjectId;
  bodySeq?: number;
};

/** The thread filter: one belief tab, or the page's own thread. */
function threadFilter(tabId: string | undefined) {
  return tabId === undefined ? { $exists: false } : tabId;
}

/**
 * Visible comments per thread of a page, counted in the database, with no
 * cap on how many there are (Chunk 9, review item 2).
 *
 * - Site comments: grouped by their own `tabId`, which is always their
 *   top-level comment's (a reply is written into its root's thread).
 * - Imported comments: an imported reply can carry a different anchor from
 *   its parent, so they are placed by their root. They are read in full: the
 *   Apple Pages import is a fixed, finite set per page.
 */
export async function commentCounts(
  commentModel: Model<CommentDocument>,
  profileId: Types.ObjectId,
): Promise<Map<string, number>> {
  const [native, imported] = await Promise.all([
    commentModel
      .aggregate<{ _id?: string | null; n: number }>([
        {
          $match: {
            profileId,
            source: 'native',
            bodySeq: { $exists: true },
            removedAt: { $exists: false },
          },
        },
        { $group: { _id: '$tabId', n: { $sum: 1 } } },
      ])
      .exec(),
    commentModel
      .find({ profileId, source: 'migrated' })
      .select({ commentId: 1, tabId: 1, parentCommentId: 1, removedAt: 1 })
      .lean()
      .exec() as Promise<CommentSkeleton[]>,
  ]);
  const counts = visibleCounts(imported);
  for (const row of native) {
    const thread = row._id ?? PAGE_THREAD;
    counts.set(thread, (counts.get(thread) ?? 0) + row.n);
  }
  return counts;
}

/**
 * The comment rows and their low-level rules (Chunk 9): listing by index,
 * walking a reply to its top-level comment, and the turns that keep an edit
 * and a removal of one comment from crossing.
 */
@Injectable()
export class CommentStore {
  private readonly logger = new Logger(CommentStore.name);

  constructor(
    @InjectModel(Comment.name)
    private readonly commentModel: Model<CommentDocument>,
  ) {}

  /** One listed row, by id. */
  async one(commentId: string): Promise<StoredComment | undefined> {
    const row = (await this.commentModel
      .findOne({ commentId, ...LISTED })
      .select(COMMENT_FIELDS)
      .lean()
      .exec()) as unknown as StoredComment | null;
    return row ?? undefined;
  }

  /**
   * The top-level comment at the end of a comment's parent chain, on this
   * page. A missing parent ends the chain there, as does a loop.
   *
   * @returns undefined when the comment itself is not on this page
   */
  async rootOf(
    profileId: Types.ObjectId,
    commentId: string,
  ): Promise<StoredComment | undefined> {
    let current = await this.one(commentId);
    if (!current || !current.profileId.equals(profileId)) return undefined;
    const seen = new Set([current.commentId]);
    for (let depth = 0; depth < MAX_THREAD_DEPTH; depth++) {
      const parentId = current.parentCommentId;
      if (parentId === undefined || seen.has(parentId)) break;
      const parent = await this.one(parentId);
      if (!parent || !parent.profileId.equals(profileId)) break;
      seen.add(parent.commentId);
      current = parent;
    }
    return current;
  }

  /**
   * One page of a thread's top-level comments, oldest first, read by index
   * ((profileId, tabId, createdAt, _id)) after the `after` comment.
   *
   * @returns undefined when `after` is not a top-level comment of this thread
   */
  async topLevel(
    profileId: Types.ObjectId,
    tabId: string | undefined,
    after?: string,
  ): Promise<{ roots: StoredComment[]; more: boolean } | undefined> {
    const where = {
      profileId,
      tabId: threadFilter(tabId),
      parentCommentId: { $exists: false },
    };
    let cursor = {};
    if (after !== undefined) {
      const from = (await this.commentModel
        .findOne({ ...where, commentId: after, ...LISTED })
        .select({ createdAt: 1, _id: 1 })
        .lean()
        .exec()) as { createdAt: Date; _id: Types.ObjectId } | null;
      if (!from) return undefined;
      cursor = {
        $or: [
          { createdAt: { $gt: from.createdAt } },
          { createdAt: from.createdAt, _id: { $gt: from._id } },
        ],
      };
    }
    const rows = (await this.commentModel
      .find({ $and: [where, LISTED, cursor] })
      .sort({ createdAt: 1, _id: 1 })
      .limit(THREAD_PAGE_SIZE + 1)
      .select(COMMENT_FIELDS)
      .lean()
      .exec()) as unknown as StoredComment[];
    return {
      roots: rows.slice(0, THREAD_PAGE_SIZE),
      more: rows.length > THREAD_PAGE_SIZE,
    };
  }

  /**
   * Every reply under these top-level comments, oldest first per root, found
   * by `parentCommentId`, level by level: a site reply is one level deep, an
   * imported reply to a reply sits one level further.
   */
  async replies(
    profileId: Types.ObjectId,
    rootIds: string[],
  ): Promise<Map<string, StoredComment[]>> {
    const byRoot = new Map<string, StoredComment[]>(
      rootIds.map((id) => [id, []]),
    );
    const rootOf = new Map(rootIds.map((id) => [id, id]));
    let frontier = rootIds;
    for (
      let depth = 0;
      depth < MAX_THREAD_DEPTH && frontier.length > 0;
      depth++
    ) {
      const children = (await this.commentModel
        .find({ profileId, parentCommentId: { $in: frontier }, ...LISTED })
        .sort({ createdAt: 1, _id: 1 })
        .select(COMMENT_FIELDS)
        .lean()
        .exec()) as unknown as StoredComment[];
      const next: string[] = [];
      for (const child of children) {
        const root = rootOf.get(String(child.parentCommentId)) as string;
        rootOf.set(child.commentId, root);
        (byRoot.get(root) as StoredComment[]).push(child);
        next.push(child.commentId);
      }
      frontier = next;
    }
    for (const list of byRoot.values()) {
      list.sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a._id.toHexString().localeCompare(b._id.toHexString()),
      );
    }
    return byRoot;
  }

  /**
   * Writes a new site comment: its row first (unlisted), then its first
   * version (`writeVersion`), then the row is confirmed. If the version
   * cannot be written the row is deleted again, so no version ever exists
   * without its comment and no comment is listed without its version.
   */
  async createConfirmed(
    fields: Record<string, unknown> & { commentId: string },
    writeVersion: () => Promise<{ seq: number }>,
  ): Promise<number> {
    await this.commentModel.create(fields);
    let seq: number;
    try {
      ({ seq } = await writeVersion());
    } catch (error) {
      await this.commentModel
        .deleteOne({ commentId: fields.commentId, bodySeq: { $exists: false } })
        .exec();
      throw error;
    }
    await this.confirm(fields.commentId, seq);
    return seq;
  }

  private async confirm(commentId: string, seq: number) {
    try {
      await this.commentModel
        .updateOne(
          { commentId, bodySeq: { $exists: false } },
          { $set: { bodySeq: seq } },
        )
        .exec();
    } catch (error) {
      // `repairUnconfirmed` confirms it on this author's next comment.
      this.logger.warn(
        `Comment ${commentId} has its version but is not confirmed yet: ${describeFailure(error)}`,
      );
    }
  }

  /**
   * Finishes or undoes an author's site comments whose writing stopped
   * part-way more than {@link COMMENT_TURN_STALE_MS} ago: one whose version
   * was written is confirmed (it becomes listed, as its author meant), one
   * without a version is deleted (nothing of it was ever recorded).
   *
   * @param versionHead - the newest version of a comment, if any
   * @returns how many rows were confirmed and deleted
   */
  async repairUnconfirmed(
    authorUserId: string,
    versionHead: (commentId: string) => Promise<number | undefined>,
  ) {
    const stale = await this.commentModel
      .find({
        authorUserId,
        source: 'native',
        bodySeq: { $exists: false },
        createdAt: { $lt: new Date(Date.now() - COMMENT_TURN_STALE_MS) },
      })
      .select({ commentId: 1 })
      .lean()
      .exec();
    const outcome = { confirmed: 0, deleted: 0 };
    for (const { commentId } of stale) {
      const seq = await versionHead(commentId);
      if (seq === undefined) {
        await this.commentModel
          .deleteOne({ commentId, bodySeq: { $exists: false } })
          .exec();
        outcome.deleted++;
      } else {
        await this.confirm(commentId, seq);
        outcome.confirmed++;
      }
    }
    return outcome;
  }

  /**
   * An edit's turn on its comment: taken in one update, only while the
   * comment is not removed. A removal waits while a turn is held, so a new
   * version can never land after the removal (review item 6). A turn older
   * than {@link COMMENT_TURN_STALE_MS} belongs to an edit that died.
   *
   * @returns the turn id, or undefined when the comment is removed or gone
   */
  async takeEditTurn(commentId: string, authorUserId: string) {
    await this.dropStaleTurns(commentId);
    const id = randomUUID();
    const taken = await this.commentModel
      .updateOne(
        { commentId, authorUserId, removedAt: { $exists: false }, ...LISTED },
        { $push: { editTurns: { id, at: new Date() } } },
      )
      .exec();
    return taken.modifiedCount === 1 ? id : undefined;
  }

  async endEditTurn(commentId: string, id: string) {
    try {
      await this.commentModel
        .updateOne({ commentId }, { $pull: { editTurns: { id } } })
        .exec();
    } catch (error) {
      // It expires after COMMENT_TURN_STALE_MS.
      this.logger.warn(
        `Could not end an edit turn on ${commentId}: ${describeFailure(error)}`,
      );
    }
  }

  private async dropStaleTurns(commentId: string) {
    const cutoff = new Date(Date.now() - COMMENT_TURN_STALE_MS);
    await this.commentModel
      .updateOne(
        { commentId, 'editTurns.at': { $lt: cutoff } },
        { $pull: { editTurns: { at: { $lt: cutoff } } } },
      )
      .exec();
  }

  /**
   * Removes a comment only while no edit holds a turn on it.
   *
   * @param extra - further conditions (a suggestion must still be pending)
   * @returns whether this call removed it
   */
  async removeWhenFree(
    commentId: string,
    authorUserId: string,
    extra: Record<string, unknown>,
  ) {
    await this.dropStaleTurns(commentId);
    const done = await this.commentModel
      .updateOne(
        {
          commentId,
          authorUserId,
          removedAt: { $exists: false },
          $or: [{ editTurns: { $exists: false } }, { editTurns: { $size: 0 } }],
          ...extra,
        },
        { $set: { removedAt: new Date(), removedBy: authorUserId } },
      )
      .exec();
    return done.modifiedCount === 1;
  }

  /** The row's copy of the newest text; only ever moves forward. */
  async updateCopy(
    commentId: string,
    body: string,
    saved: { seq: number; createdAt: Date },
  ) {
    await this.commentModel
      .updateOne(
        { commentId, bodySeq: { $lt: saved.seq } },
        { $set: { body, bodySeq: saved.seq, editedAt: saved.createdAt } },
      )
      .exec();
  }
}
