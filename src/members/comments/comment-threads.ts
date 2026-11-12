/**
 * How a page's comments form threads (Chunk 9), worked out from a light
 * "skeleton" of every comment row on the page, so threads, counts and paging
 * all come from one rule.
 *
 * - A thread is one belief tab (`tabId`), or the page itself ("About this
 *   page") for a comment with no tab (plan §2c).
 * - Replies are one level deep. A reply belongs to the thread of its ROOT, the
 *   top-level comment at the end of its parent chain, whatever its own `tabId`
 *   says: an imported reply can carry a different anchor from its parent, and
 *   an imported reply to a reply is shown under the root too.
 * - A comment whose parent is missing is its own root.
 */

/** The fields of a comment row the thread rules read. */
export interface CommentSkeleton {
  commentId: string;
  tabId?: string;
  parentCommentId?: string;
  removedAt?: Date | null;
}

/** The thread key: a tab id, or this value for the page-level thread. */
export const PAGE_THREAD = '';

/** Longest parent chain followed; anything deeper is treated as a root. */
export const MAX_THREAD_DEPTH = 32;

export interface ThreadIndex {
  /** The root of each comment. */
  rootOf: Map<string, string>;
  /** The thread each comment is shown in. */
  threadOf: Map<string, string>;
  /** Roots per thread, in skeleton order (the caller sorts oldest first). */
  rootsByThread: Map<string, string[]>;
  /** Replies per root, in skeleton order. */
  repliesOf: Map<string, string[]>;
}

/**
 * @param rows - the page's comments, oldest first; the order is kept in every
 *   list returned
 */
export function indexThreads(rows: readonly CommentSkeleton[]): ThreadIndex {
  const byId = new Map(rows.map((row) => [row.commentId, row]));
  const rootOf = new Map<string, string>();
  const findRoot = (row: CommentSkeleton): string => {
    let current = row;
    const seen = new Set<string>([current.commentId]);
    for (let depth = 0; depth < MAX_THREAD_DEPTH; depth++) {
      const parent =
        current.parentCommentId === undefined
          ? undefined
          : byId.get(current.parentCommentId);
      if (!parent || seen.has(parent.commentId)) return current.commentId;
      seen.add(parent.commentId);
      current = parent;
    }
    return current.commentId;
  };

  const threadOf = new Map<string, string>();
  const rootsByThread = new Map<string, string[]>();
  const repliesOf = new Map<string, string[]>();
  for (const row of rows) rootOf.set(row.commentId, findRoot(row));
  for (const row of rows) {
    const root = byId.get(rootOf.get(row.commentId)!)!;
    const thread = root.tabId ?? PAGE_THREAD;
    threadOf.set(row.commentId, thread);
    const list =
      root.commentId === row.commentId
        ? (rootsByThread.get(thread) ?? [])
        : (repliesOf.get(root.commentId) ?? []);
    list.push(row.commentId);
    if (root.commentId === row.commentId) rootsByThread.set(thread, list);
    else repliesOf.set(root.commentId, list);
  }
  return { rootOf, threadOf, rootsByThread, repliesOf };
}

/**
 * Comments a reader sees in each thread: every comment in it, replies
 * included, minus those removed by their author (each still holds its place
 * as "removed", but is not counted).
 */
export function visibleCounts(
  rows: readonly CommentSkeleton[],
): Map<string, number> {
  const { threadOf } = indexThreads(rows);
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.removedAt) continue;
    const thread = threadOf.get(row.commentId)!;
    counts.set(thread, (counts.get(thread) ?? 0) + 1);
  }
  return counts;
}
