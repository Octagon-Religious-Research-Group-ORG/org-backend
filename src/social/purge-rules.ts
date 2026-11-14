import { Types } from 'mongoose';
import { PERSON_DETAIL_KEYS } from '../moderation/log-details';

/**
 * The five-year purge's ONE way through the append-only guard (Chunk 17).
 *
 * ORG keeps a backend copy of a deleted page for five years (plan §2b, D22).
 * When that time is up, the personal content goes: the text, the names, the
 * Clerk ids, the addresses. The integrity structure stays: a version keeps
 * its `seq`, `createdAt`, `prevHash` and `hash`, and its anchor claim (its
 * salt and its leaf) is not touched, so the chain still links and every
 * receipt ever handed out still proves its text against the daily anchor.
 * What can no longer be done is re-hash a purged row from its fields: they
 * are gone, which is the point, and the anchor checks say so (cannot measure
 * for that row, never "pass" and never "fail").
 *
 * A collection opts in by passing its rule to `makeAppendOnly`. The guard
 * then lets through exactly one shape of write: an `updateMany` carrying
 * {@link PURGE_OPTION} whose `$set` holds only the rule's fields, each with a
 * value its predicate accepts, plus `purgedAt` as a date, and whose `$unset`
 * names only the rule's fields. Anything else, including a purge-flagged
 * write that sets one other field or one other value, is refused as before.
 */

/** The query option a purge write carries. */
export const PURGE_OPTION = 'purgeExpiredPersonalData';

/** What a purged person id reads as, everywhere. Never a real Clerk id. */
export const PURGED_PERSON = 'system:purged';

/** What a purged page's address becomes: unique, and names no one. */
export const PURGED_SLUG_PATTERN = /^former-[0-9a-f]{24}$/;

/**
 * What a purged person's MODERATOR actions read as (Chunk 17 review #5):
 * the actor stays one stable, non-identifying label per purged account
 * (the id of its `accountdeletions` row), so the log still says which
 * actions came from the same person without saying who.
 */
export const FORMER_ACTOR_PATTERN = /^system:former-[0-9a-f]{24}$/;

/** What a purged vote key becomes: random, so it cannot be tested. */
export const PURGED_VOTE_KEY_PATTERN =
  /^purged:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * How a filter may scope a purge (review round 2, #4): an identity (a
 * string, an ObjectId, or a non-empty `$in` of them), or for the visitor
 * purge a time (`{ $lt: Date }`).
 */
export type ScopeKind = 'id' | 'one' | 'before';

export interface PurgeRule {
  /** Field → the only values a purge may write there. */
  set: Readonly<Record<string, (value: unknown) => boolean>>;
  /** Fields a purge may remove. */
  unset: readonly string[];
  /** Fields whose sub-fields a purge may remove one by one (round 5, LOW-4). */
  unsetWithin?: readonly string[];
  /** The fields one of which must scope every purge of this collection. */
  scope: Readonly<Record<string, ScopeKind>>;
}

const emptyText = (value: unknown) => value === '';
const purgedPerson = (value: unknown) => value === PURGED_PERSON;
const purgedSlug = (value: unknown) =>
  typeof value === 'string' && PURGED_SLUG_PATTERN.test(value);
const purgedVoteKey = (value: unknown) =>
  typeof value === 'string' && PURGED_VOTE_KEY_PATTERN.test(value);
const emptyList = (value: unknown) =>
  Array.isArray(value) && value.length === 0;
const emptyRecord = (value: unknown) =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 0;

/** `blockversions` and `commentversions`: text and people go, hashes stay. */
export const VERSION_PURGE: PurgeRule = {
  set: { text: emptyText, authorUserId: purgedPerson },
  unset: ['suggestedBy'],
  scope: { blockId: 'id', authorUserId: 'id', suggestedBy: 'id' },
};

/** `votehistory`: the voter and the key built from their id. */
export const VOTE_HISTORY_PURGE: PurgeRule = {
  set: { voterUserId: purgedPerson, voteKey: purgedVoteKey },
  unset: [],
  scope: { voteKey: 'id', voterUserId: 'id' },
};

/** `moderationlog`: the member as actor or target, and the details. */
const formerActor = (value: unknown) =>
  typeof value === 'string' && FORMER_ACTOR_PATTERN.test(value);

export const LOG_PURGE: PurgeRule = {
  set: { actorUserId: formerActor, targetId: formerActor, reason: emptyText },
  unset: ['details'],
  unsetWithin: ['details'],
  scope: {
    actorUserId: 'id',
    targetId: 'id',
    // Entries found by VALUE (round 4, #5; round 5, LOW-4): ONE entry per
    // write, never a list, guarded by the details keys it removes, and the
    // update can still only clear details keys and the reason.
    _id: 'one',
    // Every details key that can hold a person (round 3, M-1).
    ...Object.fromEntries(
      PERSON_DETAIL_KEYS.map((key) => [`details.${key}`, 'id' as const]),
    ),
  },
};

/** `consentrecords`: who consented and from which address. */
export const CONSENT_PURGE: PurgeRule = {
  set: { userId: purgedPerson },
  unset: ['ip'],
  scope: { userId: 'id' },
};

/** `visitrecords`: the visitor's address (plan §2b D10), by visit time. */
export const VISIT_PURGE: PurgeRule = {
  set: {},
  unset: ['ip'],
  scope: { at: 'before' },
};

/** `importrecords`: the Apple Pages text and where it came from. */
export const IMPORT_PURGE: PurgeRule = {
  set: {
    extractedText: emptyText,
    pagesUrl: emptyText,
    slug: purgedSlug,
    sources: emptyList,
    report: emptyRecord,
  },
  unset: [],
  scope: { profileId: 'id' },
};

/** One person, page or block: never a shared `system:` id (round 3, L-1). */
function isIdentity(value: unknown): boolean {
  if (value instanceof Types.ObjectId) return true;
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    (!value.startsWith('system:') || FORMER_ACTOR_PATTERN.test(value))
  );
}

function scopes(value: unknown, kind: ScopeKind): boolean {
  if (kind === 'before') {
    return (
      isPlainRecord(value) &&
      Object.keys(value).length === 1 &&
      value.$lt instanceof Date
    );
  }
  if (isIdentity(value)) return true;
  if (kind === 'one') return false;
  return (
    isPlainRecord(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray(value.$in) &&
    value.$in.length > 0 &&
    value.$in.every(isIdentity)
  );
}

/**
 * Is `filter[key] = value` a not-yet guard for this update (round 3, L-1):
 * a field the update writes, matched by its OLD value (equality) or by
 * `$ne` the value the update writes; or a field the update removes,
 * matched by equality or `{ $exists: true }`. Never any other predicate,
 * so the guard always stops matching once the row is written.
 */
function isGuard(
  key: string,
  value: unknown,
  set: Record<string, unknown>,
  unset: Record<string, unknown>,
): boolean {
  if (key === 'purgedAt' || key.startsWith('$')) return false;
  const written = Object.hasOwn(set, key);
  const removedWhole = Object.hasOwn(unset, key);
  const removedWithin = Object.keys(unset).some((field) =>
    key.startsWith(`${field}.`),
  );
  if (typeof value === 'string' || value instanceof Types.ObjectId) {
    return written ? value !== set[key] : removedWhole || removedWithin;
  }
  if (!isPlainRecord(value) || Object.keys(value).length !== 1) return false;
  if (written && Object.hasOwn(value, '$ne')) return value.$ne === set[key];
  return removedWhole && value.$exists === true;
}

/**
 * Does the filter limit the purge to some rows, not done yet (review rounds
 * 1-3, #7, #4, L-1)? Both required:
 * - a SCOPING key of this collection's rule with a concrete value (one
 *   person, page or block, a non-empty list of them, never a shared
 *   `system:` id; for visits a time bound);
 * - a NOT-YET guard: `purgedAt: { $exists: false }`, or a guard on a field
 *   the update writes or removes (`isGuard`). A scoping key the update
 *   rewrites (`{ actorUserId: <id> }` rewritten to a label) is both.
 */
export function isPurgeFilter(
  filter: unknown,
  update: unknown,
  rule: PurgeRule,
): boolean {
  if (!isPlainRecord(filter) || !isPlainRecord(update)) return false;
  const scoped = Object.entries(rule.scope).some(
    ([key, kind]) => Object.hasOwn(filter, key) && scopes(filter[key], kind),
  );
  if (!scoped) return false;
  const guard = filter.purgedAt;
  if (
    isPlainRecord(guard) &&
    Object.keys(guard).length === 1 &&
    guard.$exists === false
  ) {
    return true;
  }
  const set = isPlainRecord(update.$set) ? update.$set : {};
  const unset = isPlainRecord(update.$unset) ? update.$unset : {};
  return Object.entries(filter).some(([key, value]) =>
    isGuard(key, value, set, unset),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this update exactly a purge under `rule`: `$set` (with `purgedAt` as a
 * date) and optionally `$unset`, nothing else, every field and value allowed.
 */
export function isPurgeUpdate(update: unknown, rule: PurgeRule): boolean {
  if (!isPlainRecord(update)) return false;
  const operators = Object.keys(update);
  if (!operators.every((op) => op === '$set' || op === '$unset')) return false;
  const set = update.$set;
  if (!isPlainRecord(set) || !(set.purgedAt instanceof Date)) return false;
  for (const [field, value] of Object.entries(set)) {
    if (field === 'purgedAt') continue;
    const allowed = Object.hasOwn(rule.set, field)
      ? rule.set[field]
      : undefined;
    if (!allowed || !allowed(value)) return false;
  }
  if (update.$unset === undefined) return true;
  if (!isPlainRecord(update.$unset)) return false;
  return Object.keys(update.$unset).every(
    (field) =>
      rule.unset.includes(field) ||
      (rule.unsetWithin ?? []).some(
        (within) =>
          field.startsWith(`${within}.`) &&
          !field.slice(within.length + 1).includes('.') &&
          !field.includes('$'),
      ),
  );
}
