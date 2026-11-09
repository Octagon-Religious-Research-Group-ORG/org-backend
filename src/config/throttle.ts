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
 * Member pictures: a directory page loads one per card, so the site-wide
 * limit would cut a large directory off part-way.
 */
export const PICTURE_THROTTLE = { ttl: seconds(60), limit: 600 };

/** Applies {@link WRITE_THROTTLE} to a route or controller. */
export const WriteThrottle = () => Throttle({ default: WRITE_THROTTLE });
