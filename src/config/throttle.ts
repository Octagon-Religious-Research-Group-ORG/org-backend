import { hours, Throttle, seconds } from '@nestjs/throttler';

/** Site-wide limit applied by the global ThrottlerGuard, per client IP. */
export const DEFAULT_THROTTLE = { ttl: seconds(60), limit: 120 };

/**
 * Tighter limit for member-generated writes: orders, donation reports, guest
 * carts, profile saves, and (from the members area) comments, reports and
 * claims. Ten per minute per client IP, counted separately for each route: the
 * throttler keys on the handler as well as the visitor, so one visitor can
 * spend the limit on every route. Well above human use, and it stops a script
 * flooding any one route; it is not a total across the site.
 */
export const WRITE_THROTTLE = { ttl: seconds(60), limit: 10 };

/**
 * The page-address check. Every answer says whether a page exists, including
 * pages the member hides from the directory, so it is rationed tightly: well
 * above what typing an address needs (the form waits for a pause in typing),
 * far below what walking through a list of names would need.
 */
export const SLUG_CHECK_THROTTLE = { ttl: seconds(60), limit: 20 };

/**
 * The same check per account per day: choosing an address takes a handful of
 * tries, so a day's ration stops one login walking a list of names slowly.
 */
export const SLUG_CHECK_ACCOUNT_THROTTLE = { ttl: hours(24), limit: 200 };

/** Tells the website a refusal is the daily ration, not the per-minute one. */
export const SLUG_CHECK_DAILY_LIMIT_CODE = 'ADDRESS_CHECK_DAILY_LIMIT';

/**
 * Member-page writes per account per day, across all of them. Well above what
 * setting up a page takes; each write can be a permanent history row or a
 * stored image, so one login cannot produce them without end.
 */
export const MEMBER_WRITE_ACCOUNT_THROTTLE = { ttl: hours(24), limit: 100 };

/** Tells the website a refusal is the daily ration of member-page writes. */
export const MEMBER_WRITE_DAILY_LIMIT_CODE = 'MEMBER_WRITE_DAILY_LIMIT';

/**
 * Moderation actions per admin per day (Chunk 13 review L-5): their own
 * ration, well above the member-write one, so working through a busy queue
 * does not use up the admin's own commenting and voting. The per-visitor
 * limit (`@WriteThrottle()`) still applies per minute.
 */
export const MODERATION_ACCOUNT_THROTTLE = { ttl: hours(24), limit: 1_000 };

/** Tells the website a refusal is the daily ration of moderation actions. */
export const MODERATION_DAILY_LIMIT_CODE = 'MODERATION_DAILY_LIMIT';

/**
 * Claim requests (Chunk 11) per account per day, on top of the member-write
 * ration: a member claims one page once, and each request goes to an admin.
 */
export const CLAIM_REQUEST_ACCOUNT_THROTTLE = { ttl: hours(24), limit: 5 };

/** Tells the website a refusal is the daily ration of claim requests. */
export const CLAIM_REQUEST_DAILY_LIMIT_CODE = 'CLAIM_REQUEST_DAILY_LIMIT';

/** Claim requests per visitor address per hour. */
export const CLAIM_REQUEST_THROTTLE = { ttl: hours(1), limit: 5 };

/**
 * Member pictures: a directory page loads one per card, so the site-wide
 * limit would cut a large directory off part-way.
 */
export const PICTURE_THROTTLE = { ttl: seconds(60), limit: 600 };

/** Applies {@link WRITE_THROTTLE} to a route or controller. */
export const WriteThrottle = () => Throttle({ default: WRITE_THROTTLE });

/**
 * Searches per visitor address per minute (Chunk 15): well above typing a
 * few queries and paging through them, far below walking a word list to map
 * what members have written.
 */
export const SEARCH_THROTTLE = { ttl: seconds(60), limit: 30 };
