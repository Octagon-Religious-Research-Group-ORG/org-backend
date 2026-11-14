/**
 * What can be notified (Chunk 14), in which category, and how it is said.
 *
 * Emails carry NO member text: no comment, no belief, no name, no reason.
 * They say that there is new activity and link to where the reader, signed
 * in, sees what they are allowed to see. The link itself is checked against
 * the reader's access when the email is sent (`NotificationTargets`).
 */

/** Categories a member can turn on or off one by one. */
export const MEMBER_CATEGORIES = [
  'comments',
  'replies',
  'suggestions',
  'votes',
  'claims',
  'moderation',
] as const;

/** Categories only admins receive. */
export const ADMIN_CATEGORIES = [
  'adminPages',
  'adminEam',
  'adminReports',
  'adminClaims',
] as const;

export const CATEGORIES = [...MEMBER_CATEGORIES, ...ADMIN_CATEGORIES] as const;
export type Category = (typeof CATEGORIES)[number];

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

export function isAdminCategory(category: Category): boolean {
  return (ADMIN_CATEGORIES as readonly string[]).includes(category);
}

/**
 * Categories whose emails may go out at once (plan §4: "only claim and
 * moderation emails are immediate"; for admins, new claims and reports).
 * Everything else waits for the daily digest.
 */
export const IMMEDIATE_CATEGORIES: readonly Category[] = [
  'claims',
  'moderation',
  'adminClaims',
  'adminReports',
];

export const NOTIFICATION_KINDS = [
  'comment-on-page',
  'reply',
  'suggestion-posted',
  'suggestion-decided',
  'belief-agreed',
  'claim-approved',
  'claim-rejected',
  'comment-hidden',
  'comment-removed',
  'comment-restored',
  'admin-page-submitted',
  'admin-eam-request',
  'admin-report',
  'admin-claim-requested',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const CATEGORY_OF: Record<NotificationKind, Category> = {
  'comment-on-page': 'comments',
  reply: 'replies',
  'suggestion-posted': 'suggestions',
  'suggestion-decided': 'suggestions',
  'belief-agreed': 'votes',
  'claim-approved': 'claims',
  'claim-rejected': 'claims',
  'comment-hidden': 'moderation',
  'comment-removed': 'moderation',
  'comment-restored': 'moderation',
  'admin-page-submitted': 'adminPages',
  'admin-eam-request': 'adminEam',
  'admin-report': 'adminReports',
  'admin-claim-requested': 'adminClaims',
};

/** One line per kind, singular and plural. Never any member text. */
export const LINE_OF: Record<
  NotificationKind,
  [string, (n: number) => string]
> = {
  'comment-on-page': [
    'There is a new comment on your page.',
    (n) => `There are ${n} new comments on your page.`,
  ],
  reply: [
    'Someone replied to your comment.',
    (n) => `There are ${n} new replies to your comments.`,
  ],
  'suggestion-posted': [
    'Someone suggested a rewording of one of your beliefs.',
    (n) => `There are ${n} new suggested rewordings of your beliefs.`,
  ],
  'suggestion-decided': [
    'A decision was made on a rewording you suggested.',
    (n) => `Decisions were made on ${n} rewordings you suggested.`,
  ],
  'belief-agreed': [
    'One of your beliefs is now agreed by 2 or more members.',
    (n) => `${n} of your beliefs are now agreed by 2 or more members.`,
  ],
  'claim-approved': [
    'Your request to claim a page was approved: the page is now yours.',
    (n) => `${n} of your requests to claim a page were approved.`,
  ],
  'claim-rejected': [
    'Your request to claim a page was not approved.',
    (n) => `${n} of your requests to claim a page were not approved.`,
  ],
  'comment-hidden': [
    'A moderator hid one of your comments.',
    (n) => `A moderator hid ${n} of your comments.`,
  ],
  'comment-removed': [
    'A moderator removed one of your comments.',
    (n) => `A moderator removed ${n} of your comments.`,
  ],
  'comment-restored': [
    'A moderator restored one of your comments.',
    (n) => `A moderator restored ${n} of your comments.`,
  ],
  'admin-page-submitted': [
    'A new member page is waiting for approval.',
    (n) => `${n} new member pages are waiting for approval.`,
  ],
  'admin-eam-request': [
    'A member asked to start the EaM path.',
    (n) => `${n} members asked to start the EaM path.`,
  ],
  'admin-report': [
    'There is a new report to review.',
    (n) => `There are ${n} new reports to review.`,
  ],
  'admin-claim-requested': [
    'A member asked to claim an imported page.',
    (n) => `${n} members asked to claim an imported page.`,
  ],
};

/** How a member's settings read when they have never saved any. */
export interface NotificationPrefs {
  /** Categories turned off; everything else is on. */
  off: Category[];
  /** The daily digest (on = daily). */
  digest: boolean;
  /** Immediate emails for claims and moderation. */
  immediate: boolean;
  /** Immediate emails for new claims and reports (admins). */
  adminImmediate: boolean;
}

export const DEFAULT_PREFS: NotificationPrefs = {
  off: [],
  digest: true,
  immediate: true,
  adminImmediate: true,
};

/**
 * What an unsubscribe link turns off: one category, the digest, or the
 * immediate emails.
 */
export const UNSUBSCRIBE_SCOPES = [
  ...CATEGORIES,
  'digest',
  'immediate',
  'adminImmediate',
] as const;
export type UnsubscribeScope = (typeof UNSUBSCRIBE_SCOPES)[number];

export function isUnsubscribeScope(value: string): value is UnsubscribeScope {
  return (UNSUBSCRIBE_SCOPES as readonly string[]).includes(value);
}

export type Delivery = 'digest' | 'immediate';

/**
 * How a notification reaches this member under their settings, or nothing.
 * An immediate category falls back to the digest when immediate emails are
 * off, so turning them off never loses the news.
 */
export function deliveryFor(
  category: Category,
  prefs: NotificationPrefs,
): Delivery | undefined {
  if (prefs.off.includes(category)) return undefined;
  if (IMMEDIATE_CATEGORIES.includes(category)) {
    const immediate = isAdminCategory(category)
      ? prefs.adminImmediate
      : prefs.immediate;
    if (immediate) return 'immediate';
  }
  return prefs.digest ? 'digest' : undefined;
}
