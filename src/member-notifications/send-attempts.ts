import type { NoticeOutcome } from '../notifications/notifications.service';

const HOUR_MS = 60 * 60_000;

/**
 * How long a send's idempotency key is trusted to stop a duplicate: Resend
 * keeps keys 24 hours; an hour is kept in hand for clocks and delays.
 */
export const KEY_LIFETIME_MS = 23 * HOUR_MS;

/** Why an email whose send may have happened is never tried again. */
export const UNKNOWN_GIVE_UP = 'outcome unknown; not resent';

/** What a row remembers about its sends (Chunk 14 review L2). */
export interface SendState {
  attempts: number;
  /** Bumped only after a definite refusal: a new key is then safe. */
  keyGen?: number;
  /** When a send under the current key first came back unknown. */
  unknownSince?: Date;
}

/** The idempotency key of the row's next send. */
export function sendKey(prefix: string, id: unknown, state: SendState) {
  return `${prefix}-${String(id)}-${state.keyGen ?? 0}`;
}

/**
 * Whether a send that may have happened can no longer be retried safely:
 * its key may have expired, so a retry could deliver it twice. The
 * conservative choice: give up, logged, rather than risk a duplicate.
 */
export function keyMayHaveExpired(state: SendState, now: Date): boolean {
  return (
    state.unknownSince !== undefined &&
    now.getTime() - new Date(state.unknownSince).getTime() >= KEY_LIFETIME_MS
  );
}

/**
 * The row's state after a send that did not succeed:
 * - refused: definitely not sent, so the next try gets a new key;
 * - unknown: may have been sent, so the next try keeps the same key.
 *
 * @returns the fields to set and unset, and whether the attempts ran out
 */
export function afterFailedSend(
  outcome: Exclude<NoticeOutcome, 'sent'>,
  state: SendState,
  now: Date,
  maxAttempts: number,
): {
  set: Record<string, unknown>;
  unset: Record<string, 1>;
  final: boolean;
  refused: boolean;
} {
  const attempts = state.attempts + 1;
  // 'skipped' (not configured) sent nothing either.
  const refused = outcome !== 'unknown';
  return {
    set: refused
      ? { attempts, keyGen: (state.keyGen ?? 0) + 1 }
      : { attempts, unknownSince: state.unknownSince ?? now },
    unset: refused ? { unknownSince: 1 } : {},
    final: attempts >= maxAttempts,
    refused,
  };
}
