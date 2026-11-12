/** Top-level comments per page of a thread; each comes with all its replies. */
export const THREAD_PAGE_SIZE = 20;

/** Versions per page of a comment's history. */
export const COMMENT_HISTORY_PAGE_SIZE = 20;

/**
 * Most comment rows read for one member page's threads and counts. Far above
 * any real page; a page beyond it shows and counts its oldest comments only.
 */
export const MAX_PAGE_COMMENTS = 20_000;

/** A failure as one line for the log; never the member's text. */
export function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
