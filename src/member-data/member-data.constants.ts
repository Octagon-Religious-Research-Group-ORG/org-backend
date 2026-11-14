/**
 * Data export and page deletion (Chunk 17, plan §2b D22 and item 3).
 *
 * ORG keeps a backend copy of a deleted page for at least five years (owner
 * decision D22). The clock starts when the page is deleted, never when
 * the content was written: a belief written six years ago and deleted today
 * is kept five more years.
 */
export const RETENTION_YEARS = 5;

/** How long the member can bring their own page back after deleting it. */
export const UNDO_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The end of the five-year window that starts at `at` (UTC calendar years). */
export function purgeAfterOf(at: Date): Date {
  const end = new Date(at.getTime());
  end.setUTCFullYear(end.getUTCFullYear() + RETENTION_YEARS);
  return end;
}

/** The end of the member's own undo window that starts at `at`. */
export function undoUntilOf(at: Date): Date {
  return new Date(at.getTime() + UNDO_DAYS * DAY_MS);
}

/** The wording shown in the delete dialog and sent back by the server. */
export const DELETION_DISCLOSURE = [
  'Deleting your page takes it off the website: it leaves the Members Community, search, and every link to it.',
  'ORG keeps a private copy of everything on it, and of your comments, for five years from today, as we said when you joined. Only ORG admins can read it, and it is never shown on the site.',
  `For ${UNDO_DAYS} days you can bring your page back yourself. After that, only an ORG admin can.`,
  'After five years the personal content is removed for good: your text, your name, your account id and addresses.',
  'Your comments on other members’ pages stay in their threads, shown as “A former member”, so their conversations still make sense.',
  'You can still download your data after deleting your page.',
] as const;

export const PAGE_NOT_FOUND = 'There is no member page on this account.';
export const PAGE_ALREADY_DELETED = 'Your page is already deleted.';
export const CONFIRM_MISMATCH =
  'To delete your page, type its address exactly as shown.';
export const NOT_DELETED = 'This page is not deleted.';
export const UNDO_EXPIRED =
  'The time to bring your page back yourself has passed. An ORG admin can still do it.';
export const UNDO_NOT_YOURS =
  'This page was removed when its account was deleted. Only an ORG admin can bring it back.';
export const ALREADY_PURGED =
  'This page’s personal content was removed after five years, so it cannot be brought back.';
export const PAGE_BUSY =
  'Your page is still being saved. Please try again in a minute.';
export const PAGE_CHANGED =
  'This page changed while you were working on it. Please reload and try again.';
export const OWN_PAGE_RESTORE = 'Another admin has to restore your own page.';

/** Deleted pages per admin page. */
export const DELETED_PAGE_SIZE = 30;

/** Pages purged per run, at most; the rest wait for the next day. */
export const PURGE_BATCH = 20;

/** The member page Clerk-webhook actor, as the log records it. */
export const WEBHOOK_ACTOR = 'system:clerk-webhook';

/** The purge job, as the log records it. */
export const PURGE_ACTOR = 'system:purge';
