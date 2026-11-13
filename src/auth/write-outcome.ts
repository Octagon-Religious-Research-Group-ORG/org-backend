/**
 * What is KNOWN about a Clerk write that did not succeed (review round 5).
 *
 * The rule for every Clerk write: its outcome is UNKNOWN unless an error is
 * explicitly marked as one of these. A caller may log "failed" and release its
 * lock only for a marked error; every other error, whatever it is (a 5xx, a
 * RangeError in our own code after the send, anything), means the write may
 * have been applied.
 *
 * - `refused`: Clerk definitely refused it (see `isDefiniteRefusal`);
 * - `not-sent`: it failed before the request was sent;
 * - `applied`: Clerk applied it, and something after failed (an audit write).
 */
export type Settled = 'refused' | 'not-sent' | 'applied';

const SETTLED = Symbol('org.clerkWriteSettled');

/**
 * Marks an error with what is known about the write, and returns it. A value
 * that is not an object is wrapped in an Error first, so it can carry a mark.
 */
export function settle<T>(error: T, how: Settled): T | Error {
  const target: object =
    typeof error === 'object' && error !== null
      ? error
      : new Error(String(error));
  Object.defineProperty(target, SETTLED, {
    value: how,
    enumerable: false,
    configurable: true,
  });
  return target as T | Error;
}

/** What is known about the write that threw this, or nothing. */
export function settledAs(error: unknown): Settled | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as { [SETTLED]?: Settled })[SETTLED];
}
