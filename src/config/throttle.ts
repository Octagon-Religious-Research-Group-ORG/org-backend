import { Throttle, seconds } from '@nestjs/throttler';

/** Site-wide limit applied by the global ThrottlerGuard, per client IP. */
export const DEFAULT_THROTTLE = { ttl: seconds(60), limit: 120 };

/**
 * Tighter limit for member-generated writes: orders, donation reports, guest
 * carts, profile saves, and (from the members area) comments, reports and
 * claims. Ten per minute per client IP is well above human use and stops a
 * script from flooding moderators or the notification email.
 */
export const WRITE_THROTTLE = { ttl: seconds(60), limit: 10 };

/** Applies {@link WRITE_THROTTLE} to a route or controller. */
export const WriteThrottle = () => Throttle({ default: WRITE_THROTTLE });
