import type { ProfileVisibility } from '../social/schemas/social-profile.schema';
import type { OpenTo } from './schemas/connection-settings.schema';

/** At most this many requests a member has sent may wait for an answer. */
export const MAX_PENDING_SENT = 20;

/** An unanswered request expires this long after it was sent. */
export const EXPIRY_DAYS = 90;

/** Requests sent on or before this moment have expired. */
export function expiryCutoff(now: Date): Date {
  return new Date(now.getTime() - EXPIRY_DAYS * 24 * 60 * 60_000);
}

/** After a decline, the same sender waits this long to ask the same member. */
export const COOLDOWN_DAYS = 30;

const DAY_MS = 24 * 60 * 60_000;

/** When a sender may ask again after a decline at `decidedAt`. */
export function cooldownEnds(decidedAt: Date): Date {
  return new Date(decidedAt.getTime() + COOLDOWN_DAYS * DAY_MS);
}

/** The pair's key: the two ids sorted, so A→B and B→A share it. */
export function pairKeyOf(a: string, b: string): string {
  return [a, b].sort().join('|');
}

/**
 * Who may request this member. Their own choice, if they made one;
 * otherwise the default for their page as it is NOW: nobody for a Private
 * (unlisted) page, any member for every other page. So the default follows a
 * visibility change until the member chooses for themselves.
 */
export function effectiveOpenTo(
  stored: OpenTo | undefined,
  visibility: ProfileVisibility,
): OpenTo {
  if (stored) return stored;
  return visibility === 'unlisted' ? 'nobody' : 'any-member';
}

/** One side of a request, as far as the rules need to know. */
export interface Party {
  userId: string;
  visibility: ProfileVisibility;
  /** An approved page, not removed or deleted, on a live account. */
  eligible: boolean;
}

/**
 * Why a request may not be sent, by the rules that need no counting:
 * - `self`: to yourself;
 * - `not-eligible`: the requester has no approved page;
 * - `private-needs-public`: a Private (unlisted) member may request only a
 *   member whose page is Public (plan §2d item 3);
 * - `cooldown`: the target declined this requester's last request less than
 *   30 days ago;
 * - `not-open`: the target is not open to this requester, has no approved
 *   page, or a block stands either way. One answer for all of them.
 *
 * The ORDER is what keeps a block secret (review round 2): everything a
 * block could hide is answered first, from facts that do not depend on the
 * block, and the block itself only ever produces the answer "open to
 * nobody" would give. `connections.review2.spec.ts` proves it for every
 * combination.
 */
export type RequestRefusal =
  | 'self'
  | 'not-eligible'
  | 'private-needs-public'
  | 'cooldown'
  | 'not-open';

export function requestRefusal(input: {
  requester: Party;
  target: Party;
  blocked: boolean;
  targetOpenTo: OpenTo;
  /** A decline of this requester's last request is under 30 days old. */
  coolingDown?: boolean;
}): RequestRefusal | undefined {
  const { requester, target, blocked, targetOpenTo } = input;
  if (requester.userId === target.userId) return 'self';
  if (!requester.eligible) return 'not-eligible';
  if (requester.visibility === 'unlisted' && target.visibility !== 'public') {
    return 'private-needs-public';
  }
  if (input.coolingDown) return 'cooldown';
  if (!target.eligible || blocked) return 'not-open';
  if (targetOpenTo === 'nobody') return 'not-open';
  if (targetOpenTo === 'public-members' && requester.visibility !== 'public') {
    return 'not-open';
  }
  return undefined;
}

/**
 * The refusal for a page with no member behind it (an imported page nobody
 * claimed): the Private rule first, as in `requestRefusal`, then "not open".
 * Shared by the send and the profile button so they always agree.
 */
export function noMemberRefusal(
  requester: Pick<Party, 'visibility'>,
  pageVisibility: ProfileVisibility,
): 'private-needs-public' | 'not-open' {
  return requester.visibility === 'unlisted' && pageVisibility !== 'public'
    ? 'private-needs-public'
    : 'not-open';
}
