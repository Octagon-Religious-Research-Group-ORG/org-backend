import type {
  CommentKind,
  ModerationState,
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
  /**
   * A name typed into Apple Pages; proves no identity (plan Q5). `member` is
   * the member an admin linked it to after their claim (Chunk 11), named by
   * the same rule as a site member's comment, and absent when that rule
   * names no one for this reader.
   */
  | {
      kind: 'imported';
      name: string;
      member?: { displayName: string; slug?: string };
    }
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
  /**
   * A moderator hid or removed it (Chunk 13). Shown to every reader, in
   * place, as "Hidden by a moderator" or "Removed by a moderator"; only an
   * admin still receives its text, badge and suggested wording.
   */
  moderated?: ModerationState;
  /**
   * Absent when removed by its author, and for anyone but an admin when a
   * moderator hid or removed it.
   */
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
  /** "Agree and comment" / "Disagree and comment" (Chunk 10). */
  stance?: 'agree' | 'disagree';
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
  /**
   * The start of its SHA-256, enough to compare with a receipt; only for a
   * reader who may know the author (Chunk 16 review round 2).
   */
  hash?: string;
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
  /** The member an admin linked an imported comment to (Chunk 11). */
  linkedUserId?: string;
  anchorText?: string;
  body: string;
  source: 'migrated' | 'native';
  kind?: CommentKind;
  writtenAsAdmin?: boolean;
  stance?: 'agree' | 'disagree';
  createdAt: Date;
  removedAt?: Date;
  moderation?: ModerationState;
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
  /** An admin reads what a moderator hid or removed (Chunk 13). */
  viewerIsAdmin?: boolean;
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
  const moderated = row.moderation !== undefined;
  const textHidden = removed || (moderated && !context.viewerIsAdmin);
  // A suggestion always names its belief tab.
  const current = context.tabTextSeq.get(String(row.tabId));
  return {
    ...(textHidden ? {} : { proposedText: suggestion.proposedText }),
    baseSeq: suggestion.baseSeq,
    status,
    ...(suggestion.decidedAt
      ? { decidedAt: suggestion.decidedAt.toISOString() }
      : {}),
    ...(status === 'pending' && !removed
      ? {
          stale: current !== suggestion.baseSeq,
          // A hidden suggestion cannot be accepted (Chunk 13).
          canDecide: context.viewerIsOwner && !moderated,
        }
      : {}),
  };
}

export function commentView(
  row: CommentRow,
  context: ViewContext,
): CommentView {
  const removed = Boolean(row.removedAt);
  const moderated = row.moderation;
  // Chunk 13: a moderator's decision hides the text, the highlighted text
  // and the stance badge from everyone but an admin.
  const textHidden =
    removed || (moderated !== undefined && !context.viewerIsAdmin);
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
    ...(row.stance && !textHidden ? { stance: row.stance } : {}),
    author: context.authorOf(row),
    postedAt: row.createdAt.toISOString(),
    ...(imported && row.legacyCreatedAt
      ? { importedDate: row.legacyCreatedAt.toISOString() }
      : {}),
    removed,
    ...(moderated ? { moderated } : {}),
    ...(textHidden ? {} : { body: head?.text ?? row.body }),
    ...(!textHidden && imported && row.anchorText
      ? { anchorText: row.anchorText }
      : {}),
    edited,
    ...(edited && head ? { editedAt: head.createdAt.toISOString() } : {}),
    mine: mine && !removed,
    // No edit while a moderator's decision stands (Chunk 13): `seq` is what
    // offers one.
    ...(mine && !removed && !isSuggestion && !moderated
      ? { seq: head?.seq ?? 1 }
      : {}),
    ...(suggestion ? { suggestion } : {}),
  };
}
