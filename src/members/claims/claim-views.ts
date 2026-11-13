import type { Types } from 'mongoose';
import type { ClaimStatus } from '../../social/schemas/claim.schema';

/**
 * Allowlist serialisers for claims (Chunk 11): every response field is
 * written out here by name. A claimant sees their own requests only; an
 * admin sees the queue. Nobody else learns that a page has requests.
 */

/** Why a signed-in reader may not ask to claim a page now. */
export type ClaimBlock =
  /** The account email is not confirmed. */
  | 'verify-email'
  /** The account already has a member page (of any kind, even deleted). */
  | 'has-page'
  /** The account already has a request waiting. */
  | 'has-pending'
  /** The account could not be checked just now. */
  | 'cannot-check';

/** A claim row as read for a view. */
export interface ClaimRow {
  _id: Types.ObjectId;
  profileId: Types.ObjectId;
  userId: string;
  message: string;
  status: ClaimStatus;
  approvingAt?: Date;
  decidedBy?: string;
  decidedAt?: Date;
  reason?: string;
  createdAt: Date;
}

/** The fields of a claimed page a view may name. */
export interface ClaimPageRow {
  _id: Types.ObjectId;
  slug: string;
  displayName: string;
  deletedAt?: Date;
}

/** One of the claimant's own requests. */
export interface MyClaimView {
  claimId: string;
  /** Absent when the page no longer exists. */
  page?: { slug: string; displayName: string };
  status: ClaimStatus;
  message: string;
  requestedAt: string;
  decidedAt?: string;
  /** A rejection's reason, when the admin gave one. */
  reason?: string;
}

export interface MyClaims {
  mayClaim: boolean;
  block?: ClaimBlock;
  /** Newest first. */
  claims: MyClaimView[];
}

/** One request in the admin queue. */
export interface AdminClaimView {
  claimId: string;
  status: ClaimStatus;
  /** An approval is being written right now. */
  approving: boolean;
  message: string;
  requestedAt: string;
  decidedAt?: string;
  /** The site decided it (the page went to someone else, or is gone). */
  decidedBySite: boolean;
  reason?: string;
  claimant: {
    userId: string;
    /** Absent when the account could not be read. */
    email?: string;
    emailVerified?: boolean;
  };
  /** Absent when the page no longer exists. */
  page?: { slug: string; displayName: string };
}

/** An imported comment an admin may link to an approved claimant. */
export interface LegacyCommentView {
  commentId: string;
  /** The page it is on; absent when that page no longer exists. */
  page?: { slug: string; displayName: string };
  /** The name typed into Apple Pages. */
  name: string;
  /** The date Apple Pages showed. */
  importedDate?: string;
  /** The start of its text, enough to recognise it. */
  excerpt: string;
  /** Already linked to this claimant. */
  linked: boolean;
  /** Its Pages name reads like the claimed page's name; a hint, not proof. */
  nameMatches: boolean;
}

export interface LegacyCommentList {
  owner: { slug: string; displayName: string };
  comments: LegacyCommentView[];
  /** More imported comments exist than were listed. */
  hasMore: boolean;
}

export function pageView(page: ClaimPageRow | undefined) {
  return page && !page.deletedAt
    ? { page: { slug: page.slug, displayName: page.displayName } }
    : {};
}

export function myClaimView(
  row: ClaimRow,
  page: ClaimPageRow | undefined,
): MyClaimView {
  return {
    claimId: String(row._id),
    ...pageView(page),
    status: row.status,
    message: row.message,
    requestedAt: row.createdAt.toISOString(),
    ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
    ...(row.status === 'rejected' && row.reason ? { reason: row.reason } : {}),
  };
}

/**
 * Whether a page can be asked for at all, whoever asks: an imported page,
 * approved, not deleted, with no owner yet.
 */
export function isClaimable(page: {
  source?: string;
  ownerUserId?: string;
  reviewStatus?: string;
  deletedAt?: Date | null;
}): boolean {
  return (
    page.source === 'migrated' &&
    !page.ownerUserId &&
    (page.reviewStatus ?? 'approved') === 'approved' &&
    !page.deletedAt
  );
}
