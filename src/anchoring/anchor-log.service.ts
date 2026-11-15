import { X509Certificate } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { type AnchorLogConfig, readAnchorLogConfig } from './anchor-log-config';
import { readAnchoringConfig } from './anchoring-config';
import { asBytes } from './bytes';
import {
  type DayRecord,
  dayRecordHash,
  formatDayRecord,
  parseDayRecord,
  recordOfAnchor,
} from './day-record';
import { FREETSA_ROOT_PEM } from './freetsa-certs';
import { fetchBytes } from './providers';
import { parseTimestampResponse, verifyTimestampToken } from './rfc3161';
import {
  AnchorLogCheckpoint,
  type AnchorLogCheckpointDocument,
  AnchorLogLeaf,
  type AnchorLogLeafDocument,
} from './schemas/anchor-log.schema';
import {
  TimestampAnchor,
  type TimestampAnchorDocument,
} from './schemas/timestamp-anchor.schema';
import {
  checkpointText,
  MAX_NOTE_BYTES,
  type NoteVerifier,
  openNote,
  parseCheckpoint,
  signNote,
} from './signed-note';
import { consistencyProof, inclusionProof, treeRoot } from './tlog';
import {
  buildView,
  lateBy,
  type LogView,
  type PublishedFetch,
  type ViewHead,
  type ViewInput,
} from './anchor-log-view';

export {
  LOG_SETTLE_MS,
  type DayState,
  type LogView,
  type PublishedFetch,
} from './anchor-log-view';

const MINUTE_MS = 60_000;

/** How long a fetched published checkpoint is reused. */
export const PUBLISHED_CACHE_MS = 5 * MINUTE_MS;
/** How long a failed read is reused before it is tried again. */
export const PUBLISHED_RETRY_MS = MINUTE_MS;
/** A leaf-set audit older than this is not used: cannot measure (M2). */
export const AUDIT_MAX_AGE_MS = 2 * 60 * MINUTE_MS;
/** A check never starts an audit more often than this, whatever the traffic. */
export const AUDIT_MIN_INTERVAL_MS = 10 * MINUTE_MS;
/** Anchors read per batch by the audit: bounds its memory. */
const AUDIT_BATCH = 20;

/** The latest leaf-set audit: when, and each day's leaf set. */
export interface LeafAudit {
  at: Date;
  sets: Map<string, string>;
}

/** The largest tree a proof is computed for (sizes are days: centuries). */
export const MAX_LOG_SIZE = 1_000_000;
export interface LogAppendReport {
  /** `failed`: it threw; nothing is known about the log (no size). */
  state: 'appended' | 'unchanged' | 'refused' | 'empty' | 'failed';
  /** Entries in this server's copy; absent when it could not be read. */
  size?: number;
  appended?: number;
  /** Size of the checkpoint signed by this run, if any. */
  signed?: number;
  /** Days appended more than a week after their own date (L2). */
  late?: string[];
  /**
   * Whether this run signed, as a code (review round 2, H1): `blocked`
   * with `no-key`, `no-url`, `published-missing` (a 404 outside
   * bootstrap), `published-unreadable`, `bootstrap-on` or `inconsistent`.
   */
  signing?: {
    state: 'signed' | 'unchanged' | 'blocked';
    reason?:
      | 'no-key'
      | 'no-url'
      | 'published-missing'
      | 'published-unreadable'
      | 'bootstrap-on'
      | 'inconsistent';
  };
  /** Why nothing was signed or appended. */
  note?: string;
}

/** Why a proof was not given. */
export interface ProofRefusal {
  error: 'inconsistent' | 'not-found' | 'out-of-range';
}

/** A day's inclusion proof (hashes base64, as c2sp.org/tlog-proof). */
export interface InclusionAnswer {
  origin: string;
  day: string;
  index: number;
  size: number;
  record: string;
  leafHash: string;
  proof: string[];
  root: string;
}

/**
 * Most entries one `GET /anchors/entries` gives (review round 2, M3): a
 * page of the widest records stays under half of the publication job's
 * 64 KiB answer cap.
 */
export const MAX_ENTRIES_PER_PAGE = 100;

export interface EntriesAnswer {
  origin: string;
  from: number;
  to: number;
  /** The canonical day records, in log order. */
  records: string[];
}

export interface ConsistencyAnswer {
  origin: string;
  from: number;
  to: number;
  proof: string[];
}

/** The latest checkpoint as `GET /anchors/checkpoint` serves it. */
export type CheckpointAnswer =
  | { signed: true; note: string; size: number }
  | { signed: false; size: number; root: string; reasons: string[] };

interface CachedLeaf {
  _id: number;
  day: string;
  record: string;
  hash: string;
}

interface Cache {
  records: DayRecord[];
  texts: string[];
  hashes: Buffer[];
  problem?: string;
}

type Head = Pick<
  TimestampAnchor,
  '_id' | 'status' | 'scheme' | 'merkleRoot' | 'leafCount' | 'leaves'
>;

/** What the log reads of an anchor: its head and its whole leaf list. */
const HEAD_AND_LEAVES = {
  status: 1,
  scheme: 1,
  merkleRoot: 1,
  leafCount: 1,
  'leaves.kind': 1,
  'leaves.versionId': 1,
  'leaves.versionHash': 1,
  'leaves.leaf': 1,
};

const hex = (bytes: Buffer) => bytes.toString('hex');
const b64 = (bytes: Buffer) => bytes.toString('base64');

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/** Reads the cached entries, refusing any that do not hold together. */
function readCache(rows: readonly CachedLeaf[]): Cache {
  const cache: Cache = { records: [], texts: [], hashes: [] };
  const days = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const record = parseDayRecord(row.record);
    const why =
      row._id !== index
        ? `entry ${index} is missing (found ${row._id})`
        : !record || record.day !== row.day
          ? `entry ${index} is not a valid day record`
          : hex(dayRecordHash(row.record)) !== row.hash
            ? `entry ${index}'s stored hash is not its record's`
            : days.has(record.day)
              ? `day ${record.day} is in the log twice`
              : undefined;
    if (why) return { ...cache, problem: why };
    days.add(record!.day);
    cache.records.push(record!);
    cache.texts.push(row.record);
    cache.hashes.push(dayRecordHash(row.record));
  }
  return cache;
}

/**
 * The daily anchor log (Chunk 16b): an RFC 6962 Merkle log over days, each
 * leaf the canonical record of one finished day's anchor, with C2SP signed
 * checkpoints. Mongo holds a CACHE of it: the truth is the checkpoints this
 * server signed and, above all, the latest one PUBLISHED outside this
 * server (the publication repository), against which every check here is
 * made. A database writer can rewrite this cache, never a signature, and
 * never the published copy.
 *
 * Append-only, idempotent and resumable: the entry's `_id` is its index
 * and its `day` is unique, so a second appender gets a duplicate key and
 * the next run carries on from wherever the last one stopped. Appends run
 * inside the anchoring run lock (`AnchoringService.run`).
 */
@Injectable()
export class AnchorLogService {
  private readonly logger = new Logger(AnchorLogService.name);
  readonly settings: AnchorLogConfig;
  /** FreeTSA's root, for anchors' signed times (tests pin their own). */
  trustedRoots = [new X509Certificate(FREETSA_ROOT_PEM)];
  /** The verifier's clock (tests set their own). */
  now = () => new Date();
  private readonly timeoutMs: number;
  /** The last checkpoint this process signed or read back. */
  private lastSigned?: { size: number; root: string };
  private memo?: Promise<LogView>;
  private audit?: LeafAudit;
  private auditing?: Promise<LeafAudit | undefined>;
  private auditTriedAt = Number.NEGATIVE_INFINITY;
  private published?: { at: number; result: PublishedFetch };

  constructor(
    @InjectModel(AnchorLogLeaf.name)
    private readonly leafModel: Model<AnchorLogLeafDocument>,
    @InjectModel(AnchorLogCheckpoint.name)
    private readonly checkpointModel: Model<AnchorLogCheckpointDocument>,
    @InjectModel(TimestampAnchor.name)
    private readonly anchorModel: Model<TimestampAnchorDocument>,
    config: ConfigService,
    @Optional() fetchPublished?: (url: string) => Promise<PublishedFetch>,
  ) {
    this.settings = readAnchorLogConfig(config);
    this.timeoutMs = readAnchoringConfig(config).timeoutMs;
    if (fetchPublished) this.fetchPublished = fetchPublished;
  }

  /** Reads the published checkpoint (tests replace it). */
  fetchPublished = async (url: string): Promise<PublishedFetch> => {
    try {
      const answer = await fetchBytes(url, { method: 'GET' }, this.timeoutMs);
      if (answer.status === 404) {
        return { ok: false, error: 'HTTP 404', nothing: true };
      }
      if (answer.status !== 200) {
        return { ok: false, error: `HTTP ${answer.status}` };
      }
      if (answer.body.length > MAX_NOTE_BYTES) {
        return { ok: false, error: 'too large' };
      }
      return { ok: true, note: answer.body.toString('utf8') };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  };

  /** Forgets the fetched published head: the next check reads it again. */
  refreshPublished(): void {
    this.published = undefined;
  }

  /** Starts one request's checks: the log view is worked out afresh. */
  beginCheck(): void {
    this.memo = undefined;
  }

  private async cache(): Promise<Cache> {
    const rows = (await this.leafModel
      .find({})
      .sort({ _id: 1 })
      .limit(MAX_LOG_SIZE + 1)
      .lean()
      .exec()) as CachedLeaf[];
    if (rows.length > MAX_LOG_SIZE) {
      return {
        records: [],
        texts: [],
        hashes: [],
        problem: 'too many entries',
      };
    }
    return readCache(rows);
  }

  /** The newest checkpoint this server signed, if it still verifies. */
  private async latestSigned(): Promise<
    | { size: number; root: string; note: string }
    | { problem: string }
    | undefined
  > {
    const row = (await this.checkpointModel
      .findOne({})
      .sort({ _id: -1 })
      .lean()
      .exec()) as AnchorLogCheckpoint | null;
    if (!row) return undefined;
    const verifier = this.settings.verifier;
    if (!verifier) return { size: row._id, root: row.root, note: row.note };
    const opened = openNote(row.note, verifier);
    const body = opened.ok ? parseCheckpoint(opened.text) : undefined;
    if (
      !body ||
      body.origin !== this.settings.origin ||
      body.size !== row._id ||
      hex(body.root) !== row.root
    ) {
      return {
        problem: `the stored checkpoint of size ${row._id} does not verify with this log's key`,
      };
    }
    return { size: row._id, root: row.root, note: row.note };
  }

  /** The published head, fetched at most every few minutes. */
  private async publishedHead(): Promise<PublishedFetch | undefined> {
    const url = this.settings.publishedUrl;
    if (!url) return undefined;
    const at = this.now().getTime();
    const keep = this.published?.result.ok
      ? PUBLISHED_CACHE_MS
      : PUBLISHED_RETRY_MS;
    if (this.published && at - this.published.at < keep) {
      return this.published.result;
    }
    const result = await this.fetchPublished(url);
    this.published = { at, result };
    return result;
  }

  /**
   * Checks the cache against a checkpoint: it must hold at least that many
   * entries, and its first `size` entries must give that root.
   */
  private agrees(cache: Cache, size: number, root: string): boolean {
    return (
      size <= cache.hashes.length &&
      hex(treeRoot(cache.hashes.slice(0, size))) === root
    );
  }

  /** Opens a fetched published note with the log key. */
  private openPublished(
    note: string,
    verifier: NoteVerifier,
  ): { size: number; root: string } | { problem: string } {
    const opened = openNote(note, verifier);
    if (!opened.ok) {
      return {
        problem:
          opened.reason === 'malformed'
            ? 'the published checkpoint is not a signed note'
            : opened.reason === 'unsigned'
              ? "the published checkpoint is not signed by this log's key"
              : "the published checkpoint's signature does not verify",
      };
    }
    const body = parseCheckpoint(opened.text);
    if (!body || body.origin !== this.settings.origin) {
      return { problem: 'the published checkpoint is not for this log' };
    }
    return { size: body.size, root: hex(body.root) };
  }

  /**
   * Appends every finished day not yet in the log, in day order, then signs
   * a checkpoint of the new size. Refuses, appending and signing nothing,
   * when this server's copy no longer agrees with the newest checkpoint it
   * signed or with the published one: that copy was rewritten.
   */
  async append(now = new Date()): Promise<LogAppendReport> {
    const cache = await this.cache();
    const refuse = (note: string): LogAppendReport => {
      this.logger.error(`Anchor log: refused to append or sign: ${note}`);
      return {
        state: 'refused',
        size: cache.hashes.length,
        appended: 0,
        signing: { state: 'blocked', reason: 'inconsistent' },
        note,
      };
    };
    if (cache.problem) return refuse(cache.problem);
    const signed = await this.latestSigned();
    if (signed && 'problem' in signed) return refuse(signed.problem);
    for (const head of [signed, this.lastSigned]) {
      if (head && !this.agrees(cache, head.size, head.root)) {
        return refuse(
          `this server's copy no longer gives the checkpoint it signed at size ${head.size}`,
        );
      }
    }
    const fetched = this.settings.verifier
      ? await this.publishedHead()
      : undefined;
    if (fetched?.ok) {
      const head = this.openPublished(fetched.note, this.settings.verifier!);
      if ('problem' in head) return refuse(head.problem);
      if (!this.agrees(cache, head.size, head.root)) {
        return refuse(
          `this server's copy no longer gives the published checkpoint of size ${head.size}`,
        );
      }
    }
    const logged = new Set(cache.records.map((record) => record.day));
    const finished = (await this.anchorModel
      .find({ status: { $in: ['built', 'empty'] } })
      .sort({ _id: 1 })
      .select({ status: 1, scheme: 1, merkleRoot: 1, leafCount: 1 })
      .lean()
      .exec()) as Head[];
    let appended = 0;
    const late: string[] = [];
    // A log's first append takes in all its history (a first deployment,
    // or a new log after a key rotation): late by construction, not flagged
    // (review round 2, M4). Every later late day is.
    const firstOfLog = cache.hashes.length === 0;
    for (const head of finished) {
      if (logged.has(head._id)) continue;
      // Its leaves too: the record binds the whole leaf list (L3).
      const found = (await this.anchorModel
        .findOne({ _id: head._id })
        .select(HEAD_AND_LEAVES)
        .lean()
        .exec()) as Head | null;
      const anchor = found ?? head;
      const record = recordOfAnchor(anchor, now);
      if (!record) {
        this.logger.error(
          `Anchor log: anchor ${anchor._id} is finished but has no valid root, scheme or count; left out.`,
        );
        continue;
      }
      const text = formatDayRecord(record);
      try {
        await this.leafModel.create({
          _id: cache.hashes.length,
          day: record.day,
          record: text,
          hash: hex(dayRecordHash(text)),
        });
      } catch (error) {
        if ((error as { code?: unknown }).code === 11000) break;
        throw error;
      }
      cache.records.push(record);
      cache.texts.push(text);
      cache.hashes.push(dayRecordHash(text));
      appended += 1;
      if (!firstOfLog && lateBy(record) !== undefined) {
        late.push(record.day);
        this.logger.warn(
          `Anchor log: ${record.day} appended ${lateBy(record)} days after its date (a resumed build, or a row planted under an old day id).`,
        );
      }
    }
    // Each anchoring run audits every leaf list (review round 2, M2).
    await this.refreshAudit();
    const size = cache.hashes.length;
    if (size === 0) return { state: 'empty', size, appended };
    const report: LogAppendReport = {
      state: appended > 0 ? 'appended' : 'unchanged',
      size,
      appended,
      ...(late.length > 0 ? { late } : {}),
    };
    const signer = this.settings.signer;
    const blocked = (
      reason: NonNullable<LogAppendReport['signing']>['reason'],
      note: string,
    ): LogAppendReport => {
      if (reason !== 'no-key') this.logger.error(`Anchor log: ${note}`);
      return { ...report, signing: { state: 'blocked', reason }, note };
    };
    if (!signer) {
      return blocked('no-key', 'not signed: no signing key on this server');
    }
    // Never sign blind (review rounds 1 and 2, M1 and H1): a new checkpoint
    // is signed only after the PUBLISHED head was read and agreed with. The
    // one exception is the very first checkpoint, while the owner has set
    // ANCHOR_LOG_BOOTSTRAP: a 404 then means "nothing published yet". A
    // 404 at any other time is as unreadable as a timeout, because it is
    // also what a deleted or renamed repository answers.
    if (!this.settings.publishedUrl) {
      return blocked(
        'no-url',
        'not signed: ANCHOR_LOG_PUBLISHED_URL is not set, so there is no published head to check a new checkpoint against',
      );
    }
    // And only before this server first signed one (review round 3, L1):
    // once a checkpoint is stored here (or was signed by this process), a
    // 404 means the publication is late or gone, flag or not.
    const everSigned = signed !== undefined || this.lastSigned !== undefined;
    const bootstrapping = this.settings.bootstrap && !everSigned;
    if (fetched && !fetched.ok && !(fetched.nothing && bootstrapping)) {
      return fetched.nothing
        ? blocked(
            'published-missing',
            this.settings.bootstrap
              ? 'not signed: the published checkpoint is MISSING (HTTP 404) although this server already signed one; publish it (the checkpoints workflow), then remove ANCHOR_LOG_BOOTSTRAP'
              : 'not signed: the published checkpoint is MISSING (HTTP 404) and ANCHOR_LOG_BOOTSTRAP is not set; check ANCHOR_LOG_PUBLISHED_URL and the repository',
          )
        : blocked(
            'published-unreadable',
            `not signed: the published head could not be read (${fetched.error}); the next run tries again`,
          );
    }
    // A head IS published while the flag is still on: refuse until it is
    // removed, or a later 404 would sign blind again.
    if (fetched?.ok && this.settings.bootstrap) {
      return blocked(
        'bootstrap-on',
        'not signed: a checkpoint is published, so remove ANCHOR_LOG_BOOTSTRAP; nothing is signed while it is set',
      );
    }
    if (signed && !('problem' in signed) && signed.size === size) {
      this.lastSigned = { size, root: signed.root };
      return { ...report, signing: { state: 'unchanged' } };
    }
    const root = treeRoot(cache.hashes);
    const note = signNote(
      checkpointText(this.settings.origin, size, root),
      signer,
    );
    try {
      await this.checkpointModel.create({
        _id: size,
        root: hex(root),
        note,
        verifierKey: this.settings.verifierKey,
        signedAt: now,
      });
    } catch (error) {
      if ((error as { code?: unknown }).code !== 11000) throw error;
      // Another run signed this size first: the same tree, or a fork.
      const other = (await this.checkpointModel
        .findOne({ _id: size })
        .lean()
        .exec()) as AnchorLogCheckpoint | null;
      if (other?.root !== hex(root)) {
        return refuse(`a different checkpoint of size ${size} is stored`);
      }
    }
    this.lastSigned = { size, root: hex(root) };
    return { ...report, signed: size, signing: { state: 'signed' } };
  }

  /** The latest checkpoint for `GET /anchors/checkpoint`. */
  async checkpoint(): Promise<CheckpointAnswer> {
    const cache = await this.cache();
    const reasons = [...this.settings.notes];
    if (this.settings.signer) {
      const signed = await this.latestSigned();
      if (signed && !('problem' in signed)) {
        return { signed: true, note: signed.note, size: signed.size };
      }
      reasons.push(
        signed ? signed.problem : 'no checkpoint has been signed yet',
      );
    }
    if (cache.problem) reasons.push(`this server's copy: ${cache.problem}`);
    return {
      signed: false,
      size: cache.hashes.length,
      root: b64(treeRoot(cache.problem ? [] : cache.hashes)),
      reasons,
    };
  }

  /** A day's inclusion proof in the tree of `size` entries. */
  async inclusion(
    day: string,
    size?: number,
  ): Promise<ProofRefusal | InclusionAnswer> {
    const cache = await this.cache();
    if (cache.problem) return { error: 'inconsistent' as const };
    const index = cache.records.findIndex((record) => record.day === day);
    const treeSize = size ?? cache.hashes.length;
    if (index < 0) return { error: 'not-found' as const };
    if (treeSize > cache.hashes.length || index >= treeSize) {
      return { error: 'out-of-range' as const };
    }
    const leaves = cache.hashes.slice(0, treeSize);
    return {
      origin: this.settings.origin,
      day,
      index,
      size: treeSize,
      record: cache.texts[index],
      leafHash: b64(cache.hashes[index]),
      proof: inclusionProof(index, leaves).map(b64),
      root: b64(treeRoot(leaves)),
    };
  }

  /**
   * The day records of entries `from` (inclusive) to `to` (exclusive), at
   * most {@link MAX_ENTRIES_PER_PAGE} (review round 1, M2a): hashes and
   * counts only, so the publication repository can keep them and rebuild
   * and audit the whole log without this server.
   */
  async entries(
    from: number,
    to: number,
  ): Promise<ProofRefusal | EntriesAnswer> {
    const cache = await this.cache();
    if (cache.problem) return { error: 'inconsistent' };
    if (
      from < 0 ||
      from > to ||
      to > cache.hashes.length ||
      to - from > MAX_ENTRIES_PER_PAGE
    ) {
      return { error: 'out-of-range' };
    }
    return {
      origin: this.settings.origin,
      from,
      to,
      records: cache.texts.slice(from, to),
    };
  }

  /** The consistency proof from `from` entries to `to` entries. */
  async consistency(
    from: number,
    to: number,
  ): Promise<ProofRefusal | ConsistencyAnswer> {
    const cache = await this.cache();
    if (cache.problem) return { error: 'inconsistent' as const };
    if (from < 1 || from > to || to > cache.hashes.length) {
      return { error: 'out-of-range' as const };
    }
    const leaves = cache.hashes.slice(0, to);
    return {
      origin: this.settings.origin,
      from,
      to,
      proof: consistencyProof(from, leaves).map(b64),
    };
  }

  /** The anchor's FreeTSA time, verified against its stored root. */
  private signedTime(anchor: TimestampAnchor): Date | undefined {
    const response = asBytes(anchor.tsa?.response);
    if (!response || !anchor.merkleRoot) return undefined;
    try {
      const { token } = parseTimestampResponse(response);
      if (!token) return undefined;
      const verdict = verifyTimestampToken(
        token,
        anchor.merkleRoot,
        this.trustedRoots,
      );
      return verdict.outcome === 'pass' ? verdict.tst.genTime : undefined;
    } catch {
      return undefined;
    }
  }

  /** The log against its published head, once per check (`beginCheck`). */
  view(): Promise<LogView> {
    this.memo ??= this.computeView().catch((error: unknown) => {
      this.memo = undefined;
      throw error;
    });
    return this.memo;
  }

  /**
   * The leaf-set audit (review round 2, M2): every anchor's leaves read,
   * a few anchors at a time, and hashed into its day's leaf set. Run by
   * each anchoring run, and by a check whose audit is stale, at most once
   * every {@link AUDIT_MIN_INTERVAL_MS} whatever the traffic (one shared
   * computation for a burst). Memory: one batch of leaf lists, and one
   * 64-character hash per day.
   */
  refreshAudit(): Promise<LeafAudit | undefined> {
    if (!this.auditing) {
      // Assigned BEFORE it can settle, and cleared only by itself: a run
      // that fails at once must never leave a settled promise behind as
      // "in flight" (found by the review round 2 retry test).
      const run = this.runAudit();
      this.auditing = run;
      // A new run starts only once this one is cleared: no race.
      void run.finally(() => {
        this.auditing = undefined;
      });
    }
    return this.auditing;
  }

  private async runAudit(): Promise<LeafAudit | undefined> {
    this.auditTriedAt = this.now().getTime();
    try {
      const sets = new Map<string, string>();
      let after = '';
      for (;;) {
        const batch = (await this.anchorModel
          .find({ _id: { $gt: after } })
          .sort({ _id: 1 })
          .limit(AUDIT_BATCH)
          .select(HEAD_AND_LEAVES)
          .lean()
          .exec()) as Head[];
        for (const anchor of batch) {
          const record = recordOfAnchor(anchor, new Date(0));
          if (record) sets.set(anchor._id, record.leafset);
          else if (anchor.status === 'built')
            sets.set(anchor._id, 'unreadable');
        }
        if (batch.length < AUDIT_BATCH) break;
        after = batch[batch.length - 1]._id;
      }
      this.audit = { at: this.now(), sets };
      return this.audit;
    } catch (error) {
      this.logger.error(
        `Anchor log: the leaf-set audit failed: ${describe(error)}`,
      );
      return undefined;
    }
  }

  /** The audit a check may use: fresh, or refreshed if allowed; else none. */
  private async currentAudit(): Promise<LeafAudit | undefined> {
    const now = this.now().getTime();
    if (this.audit && now - this.audit.at.getTime() <= AUDIT_MAX_AGE_MS) {
      return this.audit;
    }
    if (this.auditing) return this.auditing;
    if (now - this.auditTriedAt < AUDIT_MIN_INTERVAL_MS) return undefined;
    return this.refreshAudit();
  }

  private async computeView(): Promise<LogView> {
    const cache = await this.cache();
    // Heads only (status, scheme, root, count): leaves are the audit's job.
    const heads = (await this.anchorModel
      .find({})
      .select({ status: 1, scheme: 1, merkleRoot: 1, leafCount: 1 })
      .lean()
      .exec()) as ViewHead[];
    const verifier = this.settings.verifier;
    const signedProblems: string[] = [];
    let fetched: PublishedFetch | undefined;
    let head: ViewInput['head'];
    let everSigned = this.lastSigned !== undefined;
    if (verifier && !cache.problem) {
      const signed = await this.latestSigned();
      everSigned ||= signed !== undefined;
      if (signed && 'problem' in signed) signedProblems.push(signed.problem);
      else if (signed && !this.agrees(cache, signed.size, signed.root)) {
        signedProblems.push(
          `this server's copy no longer gives the checkpoint it signed at size ${signed.size}`,
        );
      }
      fetched = await this.publishedHead();
      if (fetched?.ok) head = this.openPublished(fetched.note, verifier);
    }
    const logged = new Set(cache.records.map((record) => record.day));
    const unlogged = heads.filter((one) => !logged.has(one._id));
    // Their tokens only: a few, where every anchor's would be megabytes.
    const tokens = (await this.anchorModel
      .find({
        _id: { $in: unlogged.map((one) => one._id) },
        status: { $in: ['built', 'empty'] },
      })
      .select({ merkleRoot: 1, tsa: 1 })
      .lean()
      .exec()) as TimestampAnchor[];
    const audit = verifier ? await this.currentAudit() : undefined;
    return buildView({
      records: cache.records,
      texts: cache.texts,
      hashes: cache.hashes,
      ...(cache.problem ? { cacheProblem: cache.problem } : {}),
      heads,
      signedTimes: new Map(
        tokens.map((anchor) => [anchor._id, this.signedTime(anchor)]),
      ),
      ...(verifier ? {} : { noKey: { notes: this.settings.notes } }),
      signedProblems,
      ...(fetched ? { fetched } : {}),
      ...(head ? { head } : {}),
      bootstrap: this.settings.bootstrap,
      everSigned,
      ...(audit ? { audit } : {}),
      ...(this.settings.verifierKey
        ? { verifierKey: this.settings.verifierKey }
        : {}),
    });
  }
}
