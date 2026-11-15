import type { Check } from './anchor-verifier.service';
import { type DayRecord, matchesHead } from './day-record';
import type { TimestampAnchor } from './schemas/timestamp-anchor.schema';
import { inclusionProof, treeRoot } from './tlog';

/**
 * Where the anchor log stands against its published head (Chunk 16b),
 * as a pure function of what the service read: split out of the service
 * in review round 2 so the per-request part stays small and testable.
 */
const DAY_MS = 24 * 60 * 60_000;

/**
 * How long after an anchor's signed FreeTSA time a LATER-appended day must
 * have been published before the anchor's absence from the log counts as
 * planted (clock skew, and a run that built it but died before appending:
 * the next run appends it).
 */
export const LOG_SETTLE_MS = DAY_MS;

/**
 * A day appended more than this long after its own date is flagged (review
 * round 1, L2): honest when a build was resumed late, but it is also what a
 * row planted under an unused old day id looks like. The log proves the
 * order and time of each append, not that the day's activity happened on
 * that date.
 */
export const LATE_APPEND_MS = 7 * DAY_MS;

/** Whole days between a day's date and its append, when past the flag. */
export function lateBy(record: DayRecord): number | undefined {
  const late =
    record.appended.getTime() - Date.parse(`${record.day}T00:00:00.000Z`);
  return late > LATE_APPEND_MS ? Math.floor(late / DAY_MS) : undefined;
}

/**
 * Why the log stands where it does, as a code a page can act on (review
 * round 2, L3: never parse a detail string).
 * - `no-key`, `no-url`: not set up;
 * - `published-missing`: the publication answered 404 outside bootstrap;
 * - `published-unreadable`: any other failed read;
 * - `nothing-published`: 404 while bootstrapping (nothing published yet);
 * - `bootstrap-on`: ANCHOR_LOG_BOOTSTRAP is still set although a head is
 *   published: nothing is signed until it is removed;
 * - `audit-stale`, `audit-missing`: the leaf-set audit (M2) is too old, or
 *   does not cover this day yet;
 * - `pending-publication`, `still-building`, `not-in-log`;
 * - `inconsistent`: the log does not hold;
 * - `mismatch`: one day's anchor no longer gives its entry.
 */
export type LogReason =
  | 'no-key'
  | 'no-url'
  | 'published-missing'
  | 'published-unreadable'
  | 'nothing-published'
  | 'bootstrap-on'
  | 'audit-stale'
  | 'audit-missing'
  | 'pending-publication'
  | 'still-building'
  | 'not-in-log'
  | 'inconsistent'
  | 'mismatch';

/** The log check, with a structured state and reason (L3). */
export interface LogCheck extends Check {
  state: 'published' | 'pending' | 'failed' | 'cannot-measure';
  reason?: LogReason;
}

export type DayState =
  | { state: 'published'; index: number; detail: string }
  | {
      state: 'pending' | 'fail' | 'cannot-measure';
      detail: string;
      reason: LogReason;
    };

/** What a verifier learns from the log, worked out once per check. */
export interface LogView {
  /** The whole log against its published head. */
  check: LogCheck;
  /** Entries in this server's copy. */
  size: number;
  /**
   * ANCHOR_LOG_BOOTSTRAP is set (review round 3, L1): shown as a warning
   * whatever the check says, because while it is set, a server whose
   * database was wiped would again take a 404 as "nothing published".
   */
  bootstrap: boolean;
  /** The verified published head, when there is one. */
  published?: { size: number; root: string; note: string };
  /** When the leaf-set audit this view used was computed (ISO), if any. */
  auditedAt?: string;
  /** Where one anchor (by its day) stands. */
  day(anchorId: string): DayState;
  /**
   * The day's record in this server's log (published or not), for a check
   * that reads that anchor's leaves itself: undefined when the log does
   * not hold or holds no such day.
   */
  recordOf(anchorId: string): DayRecord | undefined;
  /** The inclusion proof of a published day in the published head. */
  proofOf(anchorId: string):
    | {
        index: number;
        size: number;
        record: string;
        proof: string[];
        checkpoint: string;
        verifierKey?: string;
      }
    | undefined;
}

/** A published checkpoint as fetched: the note, or why it could not be. */
export type PublishedFetch =
  | { ok: true; note: string }
  /**
   * `nothing`: the publication answered 404. That is "nothing published
   * yet" ONLY while bootstrapping (review round 2, H1); otherwise a 404 is
   * as unreadable as a timeout.
   */
  | { ok: false; error: string; nothing?: true };

export type ViewHead = Pick<
  TimestampAnchor,
  '_id' | 'status' | 'scheme' | 'merkleRoot' | 'leafCount'
>;

/** Everything `buildView` needs, read by the service. */
export interface ViewInput {
  records: DayRecord[];
  texts: string[];
  hashes: Buffer[];
  /** Why this server's copy does not hold, if it does not. */
  cacheProblem?: string;
  heads: ViewHead[];
  /** FreeTSA times of finished anchors the log does not hold. */
  signedTimes: Map<string, Date | undefined>;
  /** Not set up: a verifier key is missing. */
  noKey?: { notes: string[] };
  /** Problems with the checkpoints this server stored and signed. */
  signedProblems: string[];
  /** The published head: undefined when no URL is configured. */
  fetched?: PublishedFetch;
  /** The fetched head opened, when `fetched.ok`. */
  head?: { size: number; root: string } | { problem: string };
  bootstrap: boolean;
  /**
   * This server stored (or this process signed) a checkpoint: a 404 is then
   * "missing", flag or not (review round 3, L1).
   */
  everSigned: boolean;
  /** The leaf-set audit, when fresh: day → leaf set. */
  audit?: { at: Date; sets: Map<string, string> };
  verifierKey?: string;
}

const b64 = (bytes: Buffer) => bytes.toString('base64');

export function buildView(input: ViewInput): LogView {
  const fails: string[] = [];
  let unknown: { reason: LogReason; detail: string } | undefined;
  if (input.cacheProblem) {
    fails.push(`this server's copy: ${input.cacheProblem}`);
  }
  const size = input.hashes.length;
  const agrees = (n: number, root: string) =>
    n <= size && treeRoot(input.hashes.slice(0, n)).toString('hex') === root;
  let published: LogView['published'];
  if (input.noKey) {
    unknown = { reason: 'no-key', detail: input.noKey.notes.join(' ') };
  } else if (!input.cacheProblem) {
    fails.push(...input.signedProblems);
    const fetched = input.fetched;
    if (!fetched) {
      unknown = {
        reason: 'no-url',
        detail:
          'ANCHOR_LOG_PUBLISHED_URL is not set: there is no published log to check against.',
      };
    } else if (!fetched.ok) {
      unknown = fetched.nothing
        ? input.bootstrap && !input.everSigned
          ? {
              reason: 'nothing-published',
              detail:
                'nothing is published yet (HTTP 404, ANCHOR_LOG_BOOTSTRAP is set)',
            }
          : {
              reason: 'published-missing',
              detail: input.bootstrap
                ? 'the published checkpoint is MISSING (HTTP 404) although this server already signed one: publish it, then remove ANCHOR_LOG_BOOTSTRAP; nothing new is signed until it is published'
                : 'the published checkpoint is MISSING (HTTP 404) and ANCHOR_LOG_BOOTSTRAP is not set: a wrong URL, a renamed or deleted repository, or someone made it vanish; nothing is signed until it is back',
            }
        : {
            reason: 'published-unreadable',
            detail: `the published checkpoint could not be read (${fetched.error})`,
          };
    } else {
      const head = input.head!;
      if ('problem' in head) fails.push(head.problem);
      else if (head.size > size) {
        fails.push(
          `the published log has ${head.size} entries, this server's copy only ${size}: entries were removed`,
        );
      } else if (!agrees(head.size, head.root)) {
        fails.push(
          `this server's copy no longer gives the published checkpoint of size ${head.size}: the log was rewritten`,
        );
      } else {
        published = { ...head, note: fetched.note };
      }
    }
  }
  const publishedSize = published?.size ?? 0;
  const anchors = new Map(input.heads.map((head) => [head._id, head]));
  const audit = input.audit;
  const states = new Map<string, DayState>();
  let unaudited = 0;
  for (const [index, record] of input.records.entries()) {
    const anchor = anchors.get(record.day);
    const headOk = anchor !== undefined && matchesHead(record, anchor);
    // The leaf set, from the audit (M2): a mismatch is a fail, a day the
    // audit does not cover (or no fresh audit) is unmeasured, never a pass.
    const audited = audit?.sets.get(record.day);
    const setOk =
      audited === undefined ? undefined : audited === record.leafset;
    const intact = headOk && setOk !== false;
    if (published && index < publishedSize) {
      if (!intact) {
        fails.push(
          !anchor
            ? `the anchor of ${record.day} is in the published log but missing here`
            : `the anchor of ${record.day} no longer matches its published log entry`,
        );
      }
      if (setOk === undefined) {
        unaudited += 1;
        states.set(record.day, {
          state: 'cannot-measure',
          reason: audit ? 'audit-missing' : 'audit-stale',
          detail: audit
            ? 'in the published log; its leaf list is not covered by the latest audit yet'
            : 'in the published log; no recent audit of its leaf list',
        });
        continue;
      }
      states.set(record.day, {
        state: 'published',
        index,
        detail: `in the published log (entry ${index} of ${publishedSize})${
          lateBy(record) === undefined
            ? ''
            : `; appended ${lateBy(record)} days after its day`
        }`,
      });
    } else if (!intact) {
      states.set(record.day, {
        state: 'fail',
        reason: 'mismatch',
        detail: anchor
          ? 'its anchor no longer matches its log entry'
          : 'in the log, but its anchor is missing',
      });
    } else {
      states.set(
        record.day,
        published
          ? {
              state: 'pending',
              reason: 'pending-publication',
              detail: `in this server's log since ${record.appended.toISOString()}, not yet published`,
            }
          : {
              state: 'cannot-measure',
              reason: unknown?.reason ?? 'inconsistent',
              detail: 'in the log, but the published log cannot be checked',
            },
      );
    }
  }
  // Finished anchors the log does not hold at all.
  const lastPublishedAppend = input.records
    .slice(0, publishedSize)
    .reduce((latest, record) => Math.max(latest, record.appended.getTime()), 0);
  for (const head of input.heads) {
    if (states.has(head._id)) continue;
    if (head.status !== 'built' && head.status !== 'empty') {
      states.set(head._id, {
        state: 'pending',
        reason: 'still-building',
        detail: 'still being built',
      });
      continue;
    }
    const signedAt = input.signedTimes.get(head._id);
    if (
      published &&
      signedAt &&
      lastPublishedAppend > signedAt.getTime() + LOG_SETTLE_MS
    ) {
      const detail = `finished by ${signedAt.toISOString()}, yet missing from a log published with entries appended later: it did not come through an append before that publication`;
      fails.push(`the anchor of ${head._id} was ${detail}`);
      states.set(head._id, { state: 'fail', reason: 'mismatch', detail });
    } else {
      states.set(
        head._id,
        published
          ? {
              state: 'pending',
              reason: 'pending-publication',
              detail: 'finished, not yet in the published log',
            }
          : {
              state: 'cannot-measure',
              reason: unknown?.reason ?? 'inconsistent',
              detail: 'not in the log, and the published log cannot be checked',
            },
      );
    }
  }
  const broken = fails.length > 0;
  const pending = [...states.values()].filter(
    (state) => state.state === 'pending',
  ).length;
  const bootstrapOn = Boolean(published && input.bootstrap);
  const check: LogCheck = broken
    ? {
        outcome: 'fail',
        state: 'failed',
        reason: 'inconsistent',
        detail: `the anchor log does not hold: ${fails.slice(0, 5).join('; ')}`,
      }
    : !published
      ? {
          outcome: 'cannot-measure',
          state: 'cannot-measure',
          reason: unknown!.reason,
          detail: unknown!.detail,
        }
      : unaudited > 0
        ? {
            outcome: 'cannot-measure',
            state: 'cannot-measure',
            reason: audit ? 'audit-missing' : 'audit-stale',
            detail: `${unaudited} published day(s) not covered by a recent audit of their leaf lists`,
          }
        : {
            outcome: 'pass',
            state: 'published',
            ...(bootstrapOn ? { reason: 'bootstrap-on' as const } : {}),
            detail: `${publishedSize} day(s) in the published log, all intact here; ${pending} pending publication${
              bootstrapOn
                ? '. ANCHOR_LOG_BOOTSTRAP is still set: remove it; nothing is signed while it is'
                : ''
            }`,
          };
  const failAll: DayState = {
    state: 'fail',
    reason: 'inconsistent',
    detail: check.detail,
  };
  const byDay = new Map(
    input.records.map((record, index) => [record.day, index]),
  );
  return {
    check,
    size,
    bootstrap: input.bootstrap,
    ...(published ? { published } : {}),
    ...(audit ? { auditedAt: audit.at.toISOString() } : {}),
    day: (anchorId) =>
      broken
        ? failAll
        : (states.get(anchorId) ?? {
            state: 'cannot-measure',
            reason: 'not-in-log',
            detail: 'no such anchor in the log',
          }),
    recordOf: (anchorId) => {
      const index = byDay.get(anchorId);
      return broken || index === undefined ? undefined : input.records[index];
    },
    proofOf: (anchorId) => {
      const state = states.get(anchorId);
      if (broken || !published || state?.state !== 'published') {
        return undefined;
      }
      return {
        index: state.index,
        size: published.size,
        record: input.texts[state.index],
        proof: inclusionProof(
          state.index,
          input.hashes.slice(0, published.size),
        ).map(b64),
        checkpoint: published.note,
        // A published head is only ever verified with this key.
        verifierKey: input.verifierKey,
      };
    },
  };
}
