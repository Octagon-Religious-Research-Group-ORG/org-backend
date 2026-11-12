import type {
  CommentKind,
  SuggestionStatus,
} from '../../social/schemas/comment.schema';

/**
 * Allowlist serialisers for comments (Chunk 9): every response field is
 * written out here by name. Author ids, `removedBy`, the lock fields and
 * `decidedBy` never leave the server; a removed comment's text stays in the
 * database only (5-year retention, plan §2b).
 */

/** Who wrote a comment, as a reader may see it. */
export type CommentAuthorView =
  /**
   * A site member: their page's display name only when that page is approved
   * and the reader may at least see its name, and `slug` only when the reader
   * may open the whole page. Otherwise neither: shown as "A member".
   */
  | { kind: 'member'; displayName?: string; slug?: string }
  /** A name typed into Apple Pages; proves no identity (plan Q5). */
  | { kind: 'imported'; name: string }
  /** An admin, not named (see the member case). */
  | { kind: 'admin' };

export interface SuggestionView {
  /** Absent once the suggestion was removed by its author. */
  proposedText?: string;
  baseSeq: number;
  /** `accepting` reads as pending. */
  status: Exclude<SuggestionStatus, 'accepting'>;
  decidedAt?: string;
  /** Pending, and the belief changed since it was written. */
  stale?: boolean;
  /** The viewer owns the page and may accept or decline it now. */
  canDecide?: boolean;
}

export interface CommentView {
  commentId: string;
  kind: CommentKind;
  source: 'imported' | 'member';
  author: CommentAuthorView;
  /** Server time this row was written (an import's time for imported ones). */
  postedAt: string;
  /** The date Apple Pages showed; never proof of when it was written. */
  importedDate?: string;
  removed: boolean;
  /** Absent when removed. */
  body?: string;
  /** The highlighted text an imported comment was attached to. */
  anchorText?: string;
  edited: boolean;
  editedAt?: string;
  /** The viewer wrote it, so may edit or remove it. */
  mine: boolean;
  /** The version an edit must be based on; only on the viewer's own. */
  seq?: number;
  suggestion?: SuggestionView;
  /** On a reply: the comment it answers. */
  parentCommentId?: string;
  /** Top-level comments only. */
  replies?: CommentView[];
}

export interface ThreadPage {
  comments: CommentView[];
  /** Pass as `after` for the next page; absent on the last page. */
  nextAfter?: string;
  /** Signed in with an approved page, or an admin: the form may be shown. */
  viewerMayComment: boolean;
  /** Why the form is not offered, when it is not. */
  viewerWriteBlock?:
    | 'sign-in'
    | 'needs-approved-page'
    | 'verify-email'
    | 'cannot-check';
  /** As above, and not the page's owner (owners edit instead). */
  viewerMaySuggest: boolean;
}

export interface CommentHistoryEntry {
  seq: number;
  savedAt: string;
  text: string;
  /** The start of its SHA-256, enough to compare with a receipt. */
  hash: string;
}

export interface CommentHistoryPage {
  entries: CommentHistoryEntry[];
  page: number;
  hasMore: boolean;
}

/** The row fields a view is built from. */
export interface CommentRow {
  commentId: string;
  tabId?: string;
  parentCommentId?: string;
  authorUserId?: string;
  legacyAuthorName?: string;
  legacyCreatedAt?: Date;
  anchorText?: string;
  body: string;
  source: 'migrated' | 'native';
  kind?: CommentKind;
  writtenAsAdmin?: boolean;
  createdAt: Date;
  removedAt?: Date;
  suggestion?: {
    proposedText: string;
    baseSeq: number;
    status: SuggestionStatus;
    decidedAt?: Date;
  };
}

export interface ViewContext {
  viewerUserId?: string;
  /** The viewer owns the page the comment is on. */
  viewerIsOwner: boolean;
  /** The belief text's newest version, per tab (for `stale`). */
  tabTextSeq: Map<string, number>;
  /** The newest version of each site member's comment. */
  heads: Map<string, { seq: number; text: string; createdAt: Date }>;
  authorOf: (row: CommentRow) => CommentAuthorView;
}

function suggestionView(
  row: CommentRow,
  context: ViewContext,
): SuggestionView | undefined {
  const suggestion = row.suggestion;
  if (row.kind !== 'suggestion' || !suggestion) return undefined;
  const status =
    suggestion.status === 'accepting' ? 'pending' : suggestion.status;
  const removed = Boolean(row.removedAt);
  // A suggestion always names its belief tab.
  const current = context.tabTextSeq.get(String(row.tabId));
  return {
    ...(removed ? {} : { proposedText: suggestion.proposedText }),
    baseSeq: suggestion.baseSeq,
    status,
    ...(suggestion.decidedAt
      ? { decidedAt: suggestion.decidedAt.toISOString() }
      : {}),
    ...(status === 'pending' && !removed
      ? {
          stale: current !== suggestion.baseSeq,
          canDecide: context.viewerIsOwner,
        }
      : {}),
  };
}

export function commentView(
  row: CommentRow,
  context: ViewContext,
): CommentView {
  const removed = Boolean(row.removedAt);
  const imported = row.source === 'migrated';
  const isSuggestion = row.kind === 'suggestion';
  // A suggestion is never edited; its one version records note and text.
  const head =
    imported || isSuggestion ? undefined : context.heads.get(row.commentId);
  const mine =
    !imported &&
    context.viewerUserId !== undefined &&
    row.authorUserId === context.viewerUserId;
  const edited = (head?.seq ?? 1) > 1;
  const suggestion = suggestionView(row, context);
  return {
    commentId: row.commentId,
    kind: row.kind ?? 'comment',
    source: imported ? 'imported' : 'member',
    ...(row.parentCommentId ? { parentCommentId: row.parentCommentId } : {}),
    author: context.authorOf(row),
    postedAt: row.createdAt.toISOString(),
    ...(imported && row.legacyCreatedAt
      ? { importedDate: row.legacyCreatedAt.toISOString() }
      : {}),
    removed,
    ...(removed ? {} : { body: head?.text ?? row.body }),
    ...(!removed && imported && row.anchorText
      ? { anchorText: row.anchorText }
      : {}),
    edited,
    ...(edited && head ? { editedAt: head.createdAt.toISOString() } : {}),
    mine: mine && !removed,
    ...(mine && !removed && !isSuggestion ? { seq: head?.seq ?? 1 } : {}),
    ...(suggestion ? { suggestion } : {}),
  };
}
