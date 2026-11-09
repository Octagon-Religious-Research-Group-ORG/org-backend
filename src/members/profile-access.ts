import type {
  ProfileReviewStatus,
  ProfileVisibility,
} from '../social/schemas/social-profile.schema';

/**
 * Who is asking, as far as the verified token and the database can say.
 * - `guest`: no token;
 * - `signed-in`: an account with no approved page (none yet, pending, deleted);
 * - `anonymous-member`: an approved page under a nickname;
 * - `named-member`: an approved page under the member's own name.
 */
export type ViewerKind =
  | 'guest'
  | 'signed-in'
  | 'anonymous-member'
  | 'named-member';

export interface Viewer {
  kind: ViewerKind;
  /** From the verified token only, never from anything the client sends. */
  userId?: string;
  isAdmin: boolean;
}

export const GUEST_VIEWER: Viewer = { kind: 'guest', isAdmin: false };

/** The fields of a page that decide who may see it. */
export interface ProfileAccessFacts {
  visibility: ProfileVisibility;
  /** Rows older than this field have none and read as approved. */
  reviewStatus?: ProfileReviewStatus;
  ownerUserId?: string;
  deletedAt?: Date | null;
}

/**
 * - `none`: the same 404 as a page that does not exist;
 * - `name-only`: the name and a members-only note, nothing else (plan D4);
 * - `full`: everything the page shows.
 */
export type AccessLevel = 'none' | 'name-only' | 'full';

export interface ProfileAccess {
  level: AccessLevel;
  /** May this page appear in the directory at all, for anyone. */
  listed: boolean;
  isOwner: boolean;
}

function isMember(viewer: Viewer) {
  return viewer.kind === 'anonymous-member' || viewer.kind === 'named-member';
}

/**
 * THE access decision for member pages. Every response about a page (directory
 * card, profile, picture) goes through this one function; nothing else decides.
 *
 * Anything it does not recognise, such as a visibility or review status added
 * later, falls through to no access rather than to the widest one.
 *
 * Unlisted means owner and admins only: everyone else, link holders included,
 * gets the 404 of a page that does not exist.
 *
 * @returns the viewer's level for this page, whether the page may be listed,
 *   and whether the viewer owns it
 */
export function decideProfileAccess(
  viewer: Viewer,
  profile: ProfileAccessFacts,
): ProfileAccess {
  const isOwner =
    viewer.userId !== undefined && viewer.userId === profile.ownerUserId;
  const reviewStatus = profile.reviewStatus ?? 'approved';
  const noAccess: ProfileAccess = { level: 'none', listed: false, isOwner };

  if (profile.deletedAt) return noAccess;
  if (reviewStatus === 'pending') {
    return isOwner || viewer.isAdmin
      ? { level: 'full', listed: false, isOwner }
      : noAccess;
  }
  if (reviewStatus !== 'approved') return noAccess;

  if (profile.visibility === 'unlisted') {
    return isOwner || viewer.isAdmin
      ? { level: 'full', listed: false, isOwner }
      : noAccess;
  }
  const atLeastName = (entitled: boolean): ProfileAccess => ({
    level: isOwner || viewer.isAdmin || entitled ? 'full' : 'name-only',
    listed: true,
    isOwner,
  });

  switch (profile.visibility) {
    case 'public':
      return atLeastName(true);
    case 'members':
      return atLeastName(isMember(viewer));
    case 'named-members':
      return atLeastName(viewer.kind === 'named-member');
    default:
      return noAccess;
  }
}

/** The private ORG Voting invite goes only to members with an approved page. */
export function canSeeVotingInvite(viewer: Viewer): boolean {
  return isMember(viewer);
}
