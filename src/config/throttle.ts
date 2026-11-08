import { hours, Throttle, seconds } from '@nestjs/throttler';

/** Site-wide limit applied by the global ThrottlerGuard, per client IP. */
export const DEFAULT_THROTTLE = { ttl: seconds(60), limit: 120 };

/**
 * Tighter limit for member-generated writes: orders, donation reports, guest
 * carts, profile saves, and (from the members area) comments, reports and
 * claims. Ten per minute per client IP is well above human use and stops a
 * script from flooding moderators or the notification email.
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

/** Applies {@link WRITE_THROTTLE} to a route or controller. */
export const WriteThrottle = () => Throttle({ default: WRITE_THROTTLE });
