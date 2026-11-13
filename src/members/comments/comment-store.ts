import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type Types } from 'mongoose';
import {
  Comment,
  type CommentDocument,
} from '../../social/schemas/comment.schema';
import type { CommentRow } from './comment-serializers';
import { indexThreads, PAGE_THREAD, visibleCounts } from './comment-threads';
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
  linkedUserId: 1,
  anchorText: 1,
  body: 1,
  bodySeq: 1,
  source: 1,
  kind: 1,
  writtenAsAdmin: 1,
  stance: 1,
  createdAt: 1,
  removedAt: 1,
  moderation: 1,
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

/** A page's imported comments, light, and their thread index. */
export interface ImportedIndex {
  rows: CommentSkeleton[];
  index: ReturnType<typeof indexThreads>;
}

/**
 * The light fields of a page's imported comments, for the thread index.
 * Read whole, once per thread page: the Apple Pages import is a fixed set
 * per page, so its size does not grow with use.
 */
async function importedIndex(
  commentModel: Model<CommentDocument>,
  profileId: Types.ObjectId,
) {
  // Index {profileId, source}: the import is a fixed, finite set per page.
  const rows = (await commentModel
    .find({ profileId, source: 'migrated' })
    .sort({ createdAt: 1, _id: 1 })
    .select({
      commentId: 1,
      tabId: 1,
      parentCommentId: 1,
      removedAt: 1,
      moderation: 1,
    })
    .lean()
    .exec()) as CommentSkeleton[];
  return { rows, index: indexThreads(rows) };
}

/**
 * Visible comments per thread of a page, counted in the database, with no
 * cap on how many there are (Chunk 9, review item 2).
 *
 * - Site comments: grouped by their own `tabId`, which is always their
 *   top-level comment's (a reply is written into its root's thread).
 * - Imported comments: placed by their root (`indexThreads`), exactly as the
 *   thread lists them, so a count and its thread always agree.
 */
export async function commentCounts(
  commentModel: Model<CommentDocument>,
  profileId: Types.ObjectId,
): Promise<Map<string, number>> {
  const [native, imported]: [
    Array<{ _id?: string | null; n: number }>,
    ImportedIndex,
  ] = await Promise.all([
    commentModel
      .aggregate<{ _id?: string | null; n: number }>([
        {
          $match: {
            profileId,
            source: 'native',
            bodySeq: { $exists: true },
            removedAt: { $exists: false },
            moderation: { $exists: false },
          },
        },
        { $group: { _id: '$tabId', n: { $sum: 1 } } },
      ])
      .exec(),
    importedIndex(commentModel, profileId),
  ]);
  const counts = visibleCounts(imported.rows);
  for (const row of native) {
    const thread = row._id ?? PAGE_THREAD;
    counts.set(thread, (counts.get(thread) ?? 0) + row.n);
  }
  return counts;
}

/** Oldest first, ties by database id: the order every list uses. */
function byTime(a: StoredComment, b: StoredComment) {
  return (
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a._id.toHexString().localeCompare(b._id.toHexString())
  );
}

/**
 * The comment rows and their low-level rules (Chunk 9): listing by index,
 * placing a reply under its top-level comment, and the turns that keep an
 * edit and a removal of one comment from crossing.
 *
 * Site comments are one level deep by construction (a reply is written
 * under its top-level comment). Imported comments are placed by the thread
 * index (`indexThreads`): an imported reply whose parent is missing is a
 * top-level comment, and an imported reply to a reply sits under the root.
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

  /** Listed rows by id, oldest first. */
  private async many(commentIds: string[]): Promise<StoredComment[]> {
    if (commentIds.length === 0) return [];
    const rows = (await this.commentModel
      .find({ commentId: { $in: commentIds }, ...LISTED })
      .select(COMMENT_FIELDS)
      .lean()
      .exec()) as unknown as StoredComment[];
    return rows.sort(byTime);
  }

  /**
   * The top-level comment a comment is shown under, on this page: itself, its
   * site parent, or the root of its imported chain.
   *
   * @returns undefined when the comment is not listed on this page
   */
  async rootOf(
    profileId: Types.ObjectId,
    commentId: string,
  ): Promise<StoredComment | undefined> {
    const row = await this.one(commentId);
    if (!row || !row.profileId.equals(profileId)) return undefined;
    if (row.source === 'migrated') {
      const { index } = await importedIndex(this.commentModel, profileId);
      const rootId = index.rootOf.get(commentId) as string;
      return rootId === commentId ? row : this.one(rootId);
    }
    // A site reply is written under its top-level comment: one step.
    if (row.parentCommentId === undefined) return row;
    const parent = await this.one(row.parentCommentId);
    return parent?.profileId.equals(profileId) ? parent : row;
  }

  /**
   * One page of a thread's top-level comments, oldest first, read by index
   * ((profileId, tabId, createdAt, _id)) after the `after` comment. Imported
   * comments whose parent is missing are top-level too.
   *
   * @returns undefined when `after` is not a top-level comment of this thread
   */
  async topLevel(
    profileId: Types.ObjectId,
    tabId: string | undefined,
    after?: string,
  ): Promise<
    | { roots: StoredComment[]; more: boolean; imported: ImportedIndex }
    | undefined
  > {
    const imported = await importedIndex(this.commentModel, profileId);
    const { rows, index } = imported;
    const importedRoots = rows
      .filter(
        (row) =>
          row.parentCommentId !== undefined &&
          index.rootOf.get(row.commentId) === row.commentId,
      )
      .map((row) => row.commentId);
    const where = {
      profileId,
      tabId: threadFilter(tabId),
      $or: [
        { parentCommentId: { $exists: false } },
        { commentId: { $in: importedRoots } },
      ],
    };
    let cursor = {};
    if (after !== undefined) {
      const from = (await this.commentModel
        .findOne({ $and: [where, LISTED, { commentId: after }] })
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
    const found = (await this.commentModel
      .find({ $and: [where, LISTED, cursor] })
      .sort({ createdAt: 1, _id: 1 })
      .limit(THREAD_PAGE_SIZE + 1)
      .select(COMMENT_FIELDS)
      .lean()
      .exec()) as unknown as StoredComment[];
    return {
      roots: found.slice(0, THREAD_PAGE_SIZE),
      more: found.length > THREAD_PAGE_SIZE,
      imported,
    };
  }

  /**
   * Every reply under these top-level comments, oldest first per root.
   *
   * - Site replies by `parentCommentId`, through its index: the query names
   *   `$type: 'string'` so the partial index on that field can serve it.
   * - Imported replies from the thread index, by id.
   */
  async replies(
    profileId: Types.ObjectId,
    rootIds: string[],
    imported?: ImportedIndex,
  ): Promise<Map<string, StoredComment[]>> {
    const byRoot = new Map<string, StoredComment[]>(
      rootIds.map((id) => [id, []]),
    );
    if (rootIds.length === 0) return byRoot;
    // The thread page read it already; read it here only when called alone.
    const { index } =
      imported ?? (await importedIndex(this.commentModel, profileId));
    const importedIds = rootIds.flatMap((id) => index.repliesOf.get(id) ?? []);
    const [native, importedReplies] = await Promise.all([
      this.commentModel
        .find({
          parentCommentId: { $type: 'string', $in: rootIds },
          profileId,
          source: 'native',
          ...LISTED,
        })
        .select(COMMENT_FIELDS)
        .lean()
        .exec() as unknown as Promise<StoredComment[]>,
      this.many(importedIds),
    ]);
    for (const reply of native) {
      (byRoot.get(String(reply.parentCommentId)) as StoredComment[]).push(
        reply,
      );
    }
    for (const reply of importedReplies) {
      const root = index.rootOf.get(reply.commentId) as string;
      (byRoot.get(root) as StoredComment[]).push(reply);
    }
    for (const list of byRoot.values()) list.sort(byTime);
    return byRoot;
  }

  /**
   * Writes a new site comment: its row first (unlisted), then its first
   * version (`writeVersion`), then the row is confirmed.
   *
   * It succeeds only with its row listed and confirmed (review round 2,
   * item 4): if a repair deleted the row while this write was stalled, the
   * row is written again, confirmed, from the same fields. If the version
   * cannot be written the row is deleted again. A version can be left without
   * its row only by a crash or a failure after it was written; such a version
   * is never shown (every read starts from a row) and `orphanVersions` finds
   * it.
   *
   * @throws when the row cannot be confirmed: the comment is not reported
   *   as posted
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
    const confirmed = await this.commentModel
      .updateOne(
        { commentId: fields.commentId, bodySeq: { $exists: false } },
        { $set: { bodySeq: seq } },
      )
      .exec();
    if (confirmed.modifiedCount === 1) return seq;
    const now = (await this.commentModel
      .findOne({ commentId: fields.commentId })
      .select({ bodySeq: 1 })
      .lean()
      .exec()) as { bodySeq?: number } | null;
    if (!now) {
      // A repair took the row while this write stalled: put it back, done.
      await this.commentModel.create({ ...fields, bodySeq: seq });
      return seq;
    }
    if (now.bodySeq === undefined) {
      throw new Error(`Comment ${fields.commentId} could not be confirmed.`);
    }
    return seq;
  }

  /**
   * Finishes or undoes an author's site comments whose writing stopped
   * part-way more than {@link COMMENT_TURN_STALE_MS} ago: one whose version
   * was written is confirmed (it becomes listed, as its author meant), one
   * without a version is deleted (nothing of it was ever recorded). A write
   * still in progress whose row is deleted here puts it back itself
   * (`createConfirmed`).
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
        await this.commentModel
          .updateOne(
            { commentId, bodySeq: { $exists: false } },
            { $set: { bodySeq: seq } },
          )
          .exec();
        outcome.confirmed++;
      }
    }
    return outcome;
  }

  /**
   * Comment versions with no comment row: never shown (every read starts
   * from a row), listed here so they can be found and explained, e.g. by
   * the daily anchor (Chunk 16).
   *
   * @param commentIds - the comment ids the versions name
   * @returns those with no row at all
   */
  async withoutRows(commentIds: readonly string[]): Promise<string[]> {
    const wanted = [...new Set(commentIds)];
    if (wanted.length === 0) return [];
    const rows = (await this.commentModel
      .find({ commentId: { $in: wanted } })
      .select({ commentId: 1 })
      .lean()
      .exec()) as Array<{ commentId: string }>;
    const found = new Set(rows.map((row) => row.commentId));
    return wanted.filter((id) => !found.has(id));
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
        {
          commentId,
          authorUserId,
          removedAt: { $exists: false },
          // Never while a moderator has hidden or removed it (Chunk 13).
          moderation: { $exists: false },
          ...LISTED,
        },
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
