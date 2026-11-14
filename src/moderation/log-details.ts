/**
 * Every key a moderation-log entry's `details` may hold (Chunk 17 review
 * round 3, M-1). `ModerationLogService.record` refuses any other key, so a
 * writer that adds one fails its tests until the key is registered here,
 * and registering it means saying whether it can hold a person's id.
 *
 * PERSON keys can hold a Clerk user id. The five-year account purge finds
 * the person's entries by each of them and removes the details.
 */
export const PERSON_DETAIL_KEYS = [
  'ownerUserId',
  'userId',
  'subjectUserId',
  'invitedBy',
  'authorUserId',
  // Who removed a page, in the log of its restore (admin-members).
  'removedBy',
] as const;

/** Keys that never hold a person's id. */
export const OTHER_DETAIL_KEYS = [
  'slug',
  'as',
  'from',
  'to',
  'previousStatus',
  'restoredTo',
  'kind',
  'error',
  'outcome',
  'expiresInDays',
  'invitationId',
  'emailHash',
  'domain',
  'claimId',
  'profileId',
  'tabId',
  'before',
  'reportsClosed',
  'anonymousMayVote',
  'term',
  'pages',
  'accounts',
  'failed',
  'visitAddresses',
  'removedAt',
  'emailDomain',
  'attemptId',
  // Whether an admin cleared the ORG Voting invite (org-settings, round 4).
  'cleared',
] as const;

export class UnregisteredLogDetailError extends Error {
  constructor(keys: string[]) {
    super(
      `Moderation-log details key(s) not registered in log-details.ts: ${keys.join(', ')}. Register each one, saying whether it can hold a person's id.`,
    );
    this.name = 'UnregisteredLogDetailError';
  }
}

const KNOWN = new Set<string>([...PERSON_DETAIL_KEYS, ...OTHER_DETAIL_KEYS]);

/**
 * The keys of `details` nobody registered. Under test an unregistered key
 * THROWS, so a new writer fails its tests; in production the entry is still
 * written (an admin action must not fail over a log key) and the caller
 * logs a warning.
 *
 * @throws UnregisteredLogDetailError under test, for an unregistered key
 */
export function checkLogDetails(
  details: Record<string, unknown> | undefined,
  strict = process.env.NODE_ENV === 'test',
): string[] {
  const unknown = Object.keys(details ?? {}).filter((key) => !KNOWN.has(key));
  if (unknown.length > 0 && strict)
    throw new UnregisteredLogDetailError(unknown);
  return unknown;
}
