/** Top-level comments per page of a thread; each comes with all its replies. */
export const THREAD_PAGE_SIZE = 20;

/** Versions per page of a comment's history. */
export const COMMENT_HISTORY_PAGE_SIZE = 20;

/** A failure as one line for the log; never the member's text. */
export function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
