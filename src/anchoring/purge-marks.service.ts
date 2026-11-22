import { Injectable, Optional } from '@nestjs/common';
import { createHash, X509Certificate } from 'node:crypto';
import {
  AccountDeletion,
  type AccountDeletionDocument,
} from '../member-data/schemas/account-deletion.schema';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';
import {
  purgeAfterOf,
  RETENTION_YEARS,
} from '../member-data/member-data.constants';
import type { StoredCommentVersion } from '../social/comment-versions.service';
import { PURGED_PERSON } from '../social/purge-rules';
import {
  BlockVersion,
  type BlockVersionDocument,
} from '../social/schemas/block-version.schema';
import {
  BeliefTab,
  type BeliefTabDocument,
} from '../social/schemas/belief-tab.schema';
import {
  Comment,
  type CommentDocument,
} from '../social/schemas/comment.schema';
import {
  CommentVersion,
  type CommentVersionDocument,
} from '../social/schemas/comment-version.schema';
import {
  ProfileBlock,
  type ProfileBlockDocument,
} from '../social/schemas/profile-block.schema';
import {
  SocialProfile,
  type SocialProfileDocument,
} from '../social/schemas/social-profile.schema';
import {
  COMMENT_HASH_SCHEME,
  computeVersionHash,
  GENESIS_HASH,
} from '../social/version-chain';
import {
  accountDeletedKey,
  parseAccountDeleted,
} from './account-deletion-record';
import { SWEEP_DAYS } from './anchoring.service';
import { AnchorLogService, type DayState } from './anchor-log.service';
import { leafSetHash } from './day-record';
import { asBytes } from './bytes';
import { FREETSA_ROOT_PEM } from './freetsa-certs';
import { buildTree, leafHash } from './merkle';
import { parseTimestampResponse, verifyTimestampToken } from './rfc3161';
import {
  parseRedaction,
  redactionId,
  redactionKey,
  remainingHash,
} from './redaction';
import {
  type AnchoredKind,
  AnchorLeaf,
  type AnchorLeafDocument,
  leafId,
} from './schemas/anchor-leaf.schema';
import {
  type AnchoredLeaf,
  TimestampAnchor,
  type TimestampAnchorDocument,
} from './schemas/timestamp-anchor.schema';
import type { VersionRecord } from './version-records';

/**
 * How a version row with `purgedAt` stands (Chunk 17 review rounds 1-2):
 * - `content`: text and author removed by the purge. Exactly that shape
 *   (empty text, `system:purged`, no suggester) AND its owner marked (the
 *   page's `deletion.purgeStartedAt`/`purgedAt`, the comment's `purgedAt`);
 * - `suggester` / `suggester-pending`: a version on a live page that lost
 *   only its purged suggester's id. Bound three ways: the shape (text and
 *   author intact, no suggester); the suggestion comment (a suggestion by
 *   `system:purged`, marked purged, on this block's tab, whose accepted
 *   result is this version); and the redaction record written before the
 *   id was removed, whose original hash is this version's and whose
 *   remaining hash its kept fields still give. `suggester` once that record
 *   is in a built anchor, `suggester-pending` until then;
 * - `invalid`: anything else. Such a row is checked like any other, so a
 *   tampered one FAILS.
 */
/**
 * How long after a record an anchor must have been built before its not
 * claiming the record counts as evidence (round 3, H-1b): margin for a
 * build that was already running when the record was written.
 */
export const ANCHOR_SETTLE_MS = 24 * 60 * 60 * 1000;

/**
 * How late the account-deletion record's anchor may have been built, after
 * the start of the five years that end at the redaction (round 4, #2).
 * An owner-level decision, not a derived number. Five years minus a day
 * would FAIL an honest purge whenever anchoring was slower than the purge
 * (an anchoring outage at the deletion, a purge run on time); a year
 * tolerates long anchoring outages while a forger must still have planted
 * the deletion record at least four years before the redaction.
 */
export const DELETION_ANCHOR_MARGIN_MS = 365 * 24 * 60 * 60 * 1000;

/** How far ahead of the verifier's clock a record may be dated (HIGH-1a). */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** `at` less the retention years (UTC calendar years). */
function retentionStart(at: Date): Date {
  const start = new Date(at.getTime());
  start.setUTCFullYear(start.getUTCFullYear() - RETENTION_YEARS);
  return start;
}

/** The salted leaf of a claim, or undefined for a malformed salt. */
function saltedLeaf(versionHash: string, salt: string): string | undefined {
  try {
    return leafHash(versionHash, salt);
  } catch {
    return undefined;
  }
}

/** What is read of an anchor before its leaves (round 6, 6). */
const ANCHOR_HEAD = { status: 1, builtAt: 1, merkleRoot: 1, tsa: 1 };
type AnchorHead = Pick<
  TimestampAnchor,
  '_id' | 'status' | 'builtAt' | 'merkleRoot' | 'tsa'
>;
interface CheckedAnchor {
  entries: Map<string, AnchoredLeaf>;
  /** Its leaves are not the list its anchor log entry records (M2). */
  rewritten: boolean;
  signedAt: Date | undefined | 'mismatch';
}

export type PurgeShape =
  'content' | 'suggester' | 'suggester-pending' | 'invalid';

@Injectable()
export class PurgeMarksService {
  /** The only trust anchor for signed times: FreeTSA's root (tests pin their own). */
  trustedRoots = [new X509Certificate(FREETSA_ROOT_PEM)];
  /** The verifier's clock (tests set their own). */
  now = () => new Date();
  /** How many anchors' checks are kept (round 6, 6). */
  anchorCacheSize = 16;
  private readonly anchorChecks = new Map<string, CheckedAnchor>();

  constructor(
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    @InjectModel(ProfileBlock.name)
    private readonly blockModel: Model<ProfileBlockDocument>,
    @InjectModel(BeliefTab.name)
    private readonly tabModel: Model<BeliefTabDocument>,
    @InjectModel(Comment.name)
    private readonly commentModel: Model<CommentDocument>,
    @InjectModel(CommentVersion.name)
    private readonly commentVersionModel: Model<CommentVersionDocument>,
    @InjectModel(AnchorLeaf.name)
    private readonly leafModel: Model<AnchorLeafDocument>,
    @InjectModel(TimestampAnchor.name)
    private readonly anchorModel: Model<TimestampAnchorDocument>,
    @Optional()
    @InjectModel(AccountDeletion.name)
    private readonly accountModel?: Model<AccountDeletionDocument>,
    @Optional()
    @InjectModel(BlockVersion.name)
    private readonly blockVersionModel?: Model<BlockVersionDocument>,
    @Optional() private readonly log?: AnchorLogService,
  ) {}

  /**
   * An anchor's day in the anchor log (Chunk 16b), or undefined without the
   * log (specs that predate it). With the log, an anchor proves a time only
   * once its day is in the PUBLISHED log: before that it is unsigned, and a
   * log that does not hold fails every anchor.
   */
  private async logState(anchorId: string): Promise<DayState | undefined> {
    return this.log ? (await this.log.view()).day(anchorId) : undefined;
  }

  /**
   * Did a completed anchor run miss a record written at `at` (round 3,
   * H-1b)? Evidence, not a clock: a sleeping server or anchoring switched
   * off leaves a genuine record pending, never failed.
   *
   * An anchor stores its `cutoff` (versions at or before it were
   * considered), `builtAt`, `status`, `resumeFrom` (the cap was reached;
   * versions from there on were left for later) and its rescan range, but
   * NOT the lower end of its sweep (the previous cutoff minus the
   * look-back). So the least-bad, fail-closed reading is: an anchor that
   * finished (`built` or `empty`) at least a day after `at`, with a cutoff
   * at or after `at`, that did not stop at the cap at or before `at`, and
   * was not rescanning `at`, should have claimed it. The first anchor built
   * after a genuine record always sweeps back to it, since the previous
   * cutoff is earlier than the record.
   */
  private async missedBy(at: Date): Promise<boolean> {
    // A reach point the next build will honour (`lowerBound`) means not yet
    // a miss (round 4, #4). Honestly a point stays open only on the newest
    // finished anchor, or on an older one released AFTER that build (the
    // next build clears it); a point planted anywhere else is ignored
    // (round 6, 2).
    const newest = (await this.anchorModel
      .findOne({
        status: { $in: ['built', 'empty'] },
        builtAt: { $lte: this.now() },
      })
      .sort({ builtAt: -1 })
      .select({ builtAt: 1, rescanFrom: 1, resumeOpen: 1, resumeFrom: 1 })
      .lean()
      .exec()) as Pick<
      TimestampAnchor,
      'builtAt' | 'rescanFrom' | 'resumeOpen' | 'resumeFrom'
    > | null;
    if (
      newest &&
      ((newest.rescanFrom !== undefined && newest.rescanFrom <= at) ||
        (newest.resumeOpen === true &&
          newest.resumeFrom !== undefined &&
          newest.resumeFrom <= at))
    ) {
      return false;
    }
    const releasedSince = await this.anchorModel
      .exists({
        rescanFrom: { $lte: at },
        rescanAt: {
          $gt: newest?.builtAt ?? new Date(0),
          $lte: this.now(),
        },
      })
      .exec();
    if (releasedSince) return false;
    const missed = await this.anchorModel
      .findOne({
        status: { $in: ['built', 'empty'] },
        cutoff: { $gte: at },
        builtAt: { $gte: new Date(at.getTime() + ANCHOR_SETTLE_MS) },
        $nor: [
          { resumeFrom: { $lte: at } },
          { rescanFrom: { $lte: at }, rescanTo: { $gte: at } },
        ],
      })
      .select({ _id: 1 })
      .lean()
      .exec();
    return missed !== null;
  }

  private async pagePurged(blockId: string) {
    const owner = blockId.startsWith('ttl_')
      ? await this.tabModel
          .findOne({ tabId: blockId.slice(4) })
          .select({ profileId: 1 })
          .lean()
          .exec()
      : await this.blockModel
          .findOne({ blockId })
          .select({ profileId: 1 })
          .lean()
          .exec();
    if (!owner) return false;
    const page = await this.profileModel
      .findOne({ _id: owner.profileId })
      .select({ deletion: 1 })
      .lean()
      .exec();
    return Boolean(page?.deletion?.purgeStartedAt ?? page?.deletion?.purgedAt);
  }

  /** Is this the ONE block version that names its suggestion? */
  private async onlyVersionOf(record: VersionRecord): Promise<boolean> {
    if (!this.blockVersionModel) return false;
    const naming = (await this.blockVersionModel
      .find({ suggestionId: record.suggestionId })
      .select({ _id: 1 })
      .limit(2)
      .lean()
      .exec()) as Array<{ _id: Types.ObjectId }>;
    return naming.length === 1 && String(naming[0]._id) === String(record._id);
  }

  /** The suggestion comment: purged, by no one, that wrote this version. */
  private async suggestionBound(record: VersionRecord) {
    const [comment, block] = await Promise.all([
      this.commentModel
        .findOne({ commentId: record.suggestionId })
        .select({
          kind: 1,
          authorUserId: 1,
          purgedAt: 1,
          tabId: 1,
          suggestion: 1,
        })
        .lean()
        .exec(),
      this.blockModel
        .findOne({ blockId: record.key })
        .select({ tabId: 1 })
        .lean()
        .exec(),
    ]);
    return Boolean(
      comment &&
      block &&
      comment.kind === 'suggestion' &&
      comment.authorUserId === PURGED_PERSON &&
      comment.purgedAt instanceof Date &&
      comment.tabId === block.tabId &&
      // An accept whose marking failed is still `accepting`, with no
      // result; the one-version check below binds it (round 6, 4).
      (comment.suggestion?.resultSeq === record.seq ||
        (comment.suggestion?.resultSeq === undefined &&
          comment.suggestion?.status === 'accepting')) &&
      // Recorded on accept since round 5; older suggestions lack it.
      (comment.suggestion?.resultBlockId === undefined ||
        comment.suggestion.resultBlockId === record.key) &&
      // Exactly one version names the suggestion, and it is this one
      // (round 5, MEDIUM-1). A redaction is keyed by its version, so no
      // second redaction can back the suggestion either.
      (await this.onlyVersionOf(record)),
    );
  }

  /**
   * The anchor's signed time (round 5, HIGH-1, MEDIUM-2): its stored leaves
   * must rebuild its stored root, and its FreeTSA token must verify against
   * that root and the pinned root certificates (the Chunk 16 code). Then
   * the token's `genTime`, a time no database writer can choose.
   * - `'mismatch'`: the leaves do not rebuild the root (an edited anchor);
   * - `undefined`: no verified signed time yet (no token, or one that does
   *   not verify). The OpenTimestamps Bitcoin time is never verified here
   *   (no Bitcoin node), so it never gives a time.
   */
  private signedTime(
    anchor: Pick<TimestampAnchor, 'leaves' | 'merkleRoot' | 'tsa'>,
  ): Date | undefined | 'mismatch' {
    let root: string | undefined;
    try {
      root = buildTree(anchor.leaves!.map((leaf) => leaf.leaf)).root;
    } catch {
      root = undefined;
    }
    if (!root || root !== anchor.merkleRoot) return 'mismatch';
    const response = anchor.tsa?.response
      ? asBytes(anchor.tsa.response)
      : undefined;
    if (!response) return undefined;
    try {
      const { token } = parseTimestampResponse(response);
      if (!token) return undefined;
      const verdict = verifyTimestampToken(token, root, this.trustedRoots);
      return verdict.outcome === 'pass' ? verdict.tst.genTime : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * One anchor's leaves by version id and its signed time, worked out once
   * per (anchor, root, token) within one check (round 6, 6), so parts that
   * share an anchor load and verify it once.
   */
  private async checkedAnchor(head: AnchorHead): Promise<CheckedAnchor> {
    const response = head.tsa?.response
      ? asBytes(head.tsa.response)
      : undefined;
    const key = [
      head._id,
      head.merkleRoot,
      response ? createHash('sha256').update(response).digest('hex') : '-',
    ].join('|');
    const kept = this.anchorChecks.get(key);
    if (kept) return kept;
    const stored = (await this.anchorModel
      .findOne({ _id: head._id })
      .select({ leaves: 1 })
      .lean()
      .exec()) as Pick<TimestampAnchor, 'leaves'> | null;
    const leaves = stored?.leaves ?? [];
    // The leaves this check reads must be the list the anchor log records
    // for their day (review round 2, M2): checked here, at once, for the
    // anchors this check needs; the audit covers the ones it never reads.
    const record = this.log
      ? (await this.log.view()).recordOf(head._id)
      : undefined;
    const rewritten =
      record !== undefined && record.leafset !== leafSetHash(leaves);
    const checked: CheckedAnchor = {
      entries: new Map(leaves.map((leaf) => [String(leaf.versionId), leaf])),
      rewritten,
      signedAt: rewritten ? 'mismatch' : this.signedTime({ ...head, leaves }),
    };
    if (this.anchorChecks.size >= this.anchorCacheSize) {
      const [oldest] = this.anchorChecks.keys();
      this.anchorChecks.delete(oldest);
    }
    this.anchorChecks.set(key, checked);
    return checked;
  }

  /**
   * Where a stored reserved-chain row stands in the anchors (round 4, #3;
   * round 5): its claim AND the anchor's own `leaves[]` entry for it, as
   * `AnchorVerifierService.checkVersions` reads them, the anchor's tree
   * rebuilding its root, and the anchor's signed time.
   * - `unclaimed`: no claim;
   * - `mismatch`: the claim, the anchored hash, the salted leaf or the
   *   root differs;
   * - `pending`: claimed by an anchor not built (yet), or a stray claim
   *   outside its anchor's tree (a builder that died; the sweep releases it);
   * - `unsigned`: anchored, but with no verified signed time yet;
   * - `anchored`, with the anchor's signed time.
   */
  private async anchoredIn(row: {
    _id: unknown;
    hash: string;
  }): Promise<
    | { state: 'unclaimed' | 'mismatch' | 'pending' }
    | { state: 'unsigned'; anchorId: string; salt: string }
    | { state: 'anchored'; signedAt: Date; anchorId: string; salt: string }
  > {
    const claim = await this.leafModel
      .findOne({ _id: leafId('comment', row._id as Types.ObjectId) })
      .lean()
      .exec();
    if (!claim) return { state: 'unclaimed' };
    // A claim with another hash: the record was rewritten after it was
    // anchored (round 3, H-1a).
    if (claim.versionHash !== row.hash) return { state: 'mismatch' };
    const anchor = (await this.anchorModel
      .findOne({ _id: claim.anchorId })
      .select(ANCHOR_HEAD)
      .lean()
      .exec()) as AnchorHead | null;
    if (anchor?.status !== 'built') return { state: 'pending' };
    const checked = await this.checkedAnchor(anchor);
    // Leaves that no longer give the anchor's log entry: a mismatch before
    // anything else, a missing entry included (round 2, M2).
    if (checked.rewritten) return { state: 'mismatch' };
    const entry = checked.entries.get(String(row._id));
    if (!entry || entry.kind !== 'comment') return { state: 'pending' };
    if (
      entry.versionHash !== row.hash ||
      saltedLeaf(entry.versionHash, claim.salt) !== entry.leaf
    ) {
      return { state: 'mismatch' };
    }
    const signedAt = checked.signedAt;
    if (signedAt === 'mismatch') return { state: 'mismatch' };
    // Its day in the published log (Chunk 16b): the database writer who
    // deletes an honest anchor and re-stamps a forgery cannot change that.
    const day = await this.logState(claim.anchorId);
    if (day?.state === 'fail') return { state: 'mismatch' };
    const held = { anchorId: claim.anchorId, salt: claim.salt };
    if (signedAt) {
      // Signed but not yet published (or not checkable): no time yet.
      return day && day.state !== 'published'
        ? { state: 'unsigned', ...held }
        : { state: 'anchored', signedAt, ...held };
    }
    // No verified token: pending only inside the TSA retry and sweep window
    // (round 6, 3b) and never dated ahead of the clock (round 7, 3). A newer
    // anchor being signed proves nothing about this one: each anchor has its
    // own backoff and the server may sleep through a retry (round 8). So a
    // database writer can hold a row pending by refreshing a planted
    // anchor's `builtAt`, never make it pass (README).
    const builtAt = anchor.builtAt!;
    if (
      !this.inRetryWindow(builtAt) ||
      builtAt.getTime() > this.now().getTime() + CLOCK_SKEW_MS
    ) {
      return { state: 'mismatch' };
    }
    return { state: 'unsigned', ...held };
  }

  /**
   * The anchors are the memory (round 6, 1a; round 7, 1-2). Honestly a
   * row's id is in exactly one anchor's tree, the one its claim names, so
   * EVERY anchor whose stored leaves hold the id is checked, whatever its
   * status:
   * - it must be built, and its leaves must rebuild its root;
   * - its entry must be this row's hash, and its stored leaf the salted
   *   leaf of that hash under the claim's salt (the stored hash is not in
   *   the signed tree; the leaf is);
   * - the claim must be in its anchor's tree, and that anchor must be the
   *   earliest signed holder.
   * Any other holder is a mismatch, never skipped. A row re-issued after
   * its first anchoring therefore FAILS. Deleting or rewriting the honest
   * anchor document outright is caught by the anchor log (Chunk 16b) for
   * any published day; the unpublished tail is in the README.
   */
  private async firstAnchored(row: {
    _id: unknown;
    hash: string;
  }): ReturnType<PurgeMarksService['anchoredIn']> {
    const placed = await this.anchoredIn(row);
    if (placed.state === 'mismatch') return placed;
    const held = (await this.anchorModel
      .find({ 'leaves.versionId': row._id as Types.ObjectId })
      .select(ANCHOR_HEAD)
      .lean()
      .exec()) as AnchorHead[];
    if (held.length === 0) return placed;
    const mismatch = { state: 'mismatch' as const };
    if (placed.state !== 'anchored' && placed.state !== 'unsigned') {
      return mismatch;
    }
    let earliest: { anchorId: string; at: number } | undefined;
    for (const anchor of held) {
      if (anchor.status !== 'built') return mismatch;
      if ((await this.logState(anchor._id))?.state === 'fail') return mismatch;
      const { entries, signedAt } = await this.checkedAnchor(anchor);
      if (signedAt === 'mismatch') return mismatch;
      const entry = entries.get(String(row._id));
      if (
        entry?.kind !== 'comment' ||
        entry.versionHash !== row.hash ||
        saltedLeaf(entry.versionHash, placed.salt) !== entry.leaf
      ) {
        return mismatch;
      }
      if (signedAt && signedAt.getTime() < (earliest?.at ?? Infinity)) {
        earliest = { anchorId: anchor._id, at: signedAt.getTime() };
      }
    }
    if (earliest && earliest.anchorId !== placed.anchorId) return mismatch;
    return placed;
  }

  /**
   * The redaction is backed by its account's deletion (round 4, #1, #2):
   * - the named `accountdeletions` row exists, its five years were up when
   *   the record was written, and the record's time is one of that row's
   *   `purgeRuns` (the purge adds each run's clock before writing);
   * - its `account-deleted:` chain is whole (every part rehashes, links,
   *   names this row and its deletion time) and every part is anchored in
   *   an intact anchor;
   * - the suggestion is one of the ids that chain lists.
   * Anything else, an absent chain included, fails closed. `signedAt` is
   * the latest signed time over the parts' anchors (T_d, round 5), and
   * `unsigned` says some part's anchor has no verified signed time yet.
   */
  /** Is an anchor built at `at` still inside the TSA retry and sweep window? */
  private inRetryWindow(at: Date | undefined): boolean {
    return (
      at instanceof Date &&
      this.now().getTime() - at.getTime() <= SWEEP_DAYS * 24 * 60 * 60 * 1000
    );
  }

  private async deletionBound(
    accountId: string,
    at: Date,
    suggestionId: string,
  ): Promise<
    | { state: 'mismatch' }
    | { state: 'unsigned' }
    | { state: 'ok'; signedAt: Date }
  > {
    const mismatch = { state: 'mismatch' as const };
    if (!this.accountModel || !Types.ObjectId.isValid(accountId)) {
      return mismatch;
    }
    const account = (await this.accountModel
      .findOne({ _id: new Types.ObjectId(accountId) })
      .select({ at: 1, purgeRuns: 1 })
      .lean()
      .exec()) as { at: Date; purgeRuns?: Date[] } | null;
    if (
      !account ||
      purgeAfterOf(account.at) > at ||
      !(account.purgeRuns ?? []).some((run) => run.getTime() === at.getTime())
    ) {
      return mismatch;
    }
    const parts = (await this.commentVersionModel
      .find({ commentId: accountDeletedKey(accountId) })
      .sort({ seq: 1 })
      .lean()
      .exec()) as unknown as Array<
      StoredCommentVersion & { _id: Types.ObjectId }
    >;
    const ids = new Set<string>();
    let prevHash = GENESIS_HASH;
    let latest = 0;
    let unsigned = false;
    for (const [index, part] of parts.entries()) {
      const claim = parseAccountDeleted(part.text);
      if (
        computeVersionHash(
          { ...part, blockId: part.commentId },
          COMMENT_HASH_SCHEME,
        ) !== part.hash ||
        part.seq !== index + 1 ||
        part.prevHash !== prevHash ||
        part.createdAt.getTime() !== account.at.getTime() ||
        !claim ||
        claim.accountId !== accountId ||
        claim.deletedAt !== account.at.toISOString() ||
        claim.part !== part.seq ||
        claim.parts !== parts.length
      ) {
        return mismatch;
      }
      const placed = await this.anchoredIn(part);
      if (placed.state === 'unsigned') unsigned = true;
      else if (placed.state === 'anchored') {
        latest = Math.max(latest, placed.signedAt.getTime());
      } else return mismatch;
      for (const id of claim.commentIds) ids.add(id);
      prevHash = part.hash;
    }
    if (parts.length === 0 || !ids.has(suggestionId)) return mismatch;
    return unsigned
      ? { state: 'unsigned' }
      : { state: 'ok', signedAt: new Date(latest) };
  }

  /** The redaction record: intact, matching this row, and anchored or not. */
  private async redaction(
    record: VersionRecord,
  ): Promise<'anchored' | 'pending' | 'mismatch'> {
    const row = await this.commentVersionModel
      .findOne({ commentId: redactionKey(record._id), seq: 1 })
      .lean()
      .exec();
    if (!row) return 'mismatch';
    const claim = parseRedaction(row.text);
    const intact =
      computeVersionHash(
        { ...row, blockId: row.commentId },
        COMMENT_HASH_SCHEME,
      ) === row.hash;
    if (
      !intact ||
      !claim ||
      claim.versionId !== String(record._id) ||
      claim.originalHash !== record.hash ||
      claim.remainingHash !== remainingHash(record)
    ) {
      return 'mismatch';
    }
    // Only under its own derived id (round 6, 1a).
    if (String(row._id) !== String(redactionId(record._id))) return 'mismatch';
    const now = this.now();
    // Dated in the future: a forgery waiting for its date (round 5, HIGH-1a).
    if (row.createdAt.getTime() > now.getTime() + CLOCK_SKEW_MS) {
      return 'mismatch';
    }
    // Written by its suggester's account purge, in one of its runs, and
    // backed by that account's anchored deletion record (round 4, #1, #2).
    const deletion = await this.deletionBound(
      claim.accountId,
      row.createdAt,
      record.suggestionId!,
    );
    if (deletion.state === 'mismatch') return 'mismatch';
    const placed = await this.firstAnchored(row);
    if (placed.state === 'mismatch') return 'mismatch';
    // An anchor with no verified signed time: no age can be measured yet,
    // but the missed-claim evidence still applies (round 6, 3a).
    if (deletion.state === 'unsigned') {
      return placed.state === 'unclaimed' &&
        (await this.missedBy(row.createdAt))
        ? 'mismatch'
        : 'pending';
    }
    // The ages, by SIGNED time only (round 5, HIGH-1b): the redaction's
    // anchor time, or now while it is unanchored, must be at least five
    // years less the margin after the deletion record's anchor time.
    const reference = placed.state === 'anchored' ? placed.signedAt : now;
    const start = retentionStart(reference).getTime();
    if (deletion.signedAt.getTime() > start + DELETION_ANCHOR_MARGIN_MS) {
      return 'mismatch';
    }
    // And no more than the margin later (round 6, 1b), when the redaction's
    // time is signed; its own time can be no later than that (1c), give or
    // take the clock skew between this server and FreeTSA (round 9, F1).
    if (
      placed.state === 'anchored' &&
      (deletion.signedAt.getTime() < start - DELETION_ANCHOR_MARGIN_MS ||
        row.createdAt.getTime() > placed.signedAt.getTime() + CLOCK_SKEW_MS)
    ) {
      return 'mismatch';
    }
    // Unclaimed: pending, however long that takes, unless an anchor run
    // that should have claimed it finished without doing so (H-1b).
    if (placed.state === 'unclaimed') {
      return (await this.missedBy(row.createdAt)) ? 'mismatch' : 'pending';
    }
    return placed.state === 'anchored' ? 'anchored' : 'pending';
  }

  /**
   * Starts one request's checks (round 7, 7): a health report, one
   * `verifyAnchor`, or one receipt. Anchor checks are kept from here until
   * the next call, so rows sharing an anchor load and verify it once, while
   * each request reads stored leaves as they are now (they can be edited
   * without moving the root). Every caller of {@link classify} calls this
   * first.
   */
  beginCheck(): void {
    this.anchorChecks.clear();
    this.log?.beginCheck();
  }

  async classify(
    kind: AnchoredKind,
    record: VersionRecord,
  ): Promise<PurgeShape> {
    const contentShape =
      record.text === '' &&
      record.authorUserId === PURGED_PERSON &&
      record.suggestedBy === undefined;
    if (kind === 'comment') {
      if (!contentShape) return 'invalid';
      const row = await this.commentModel
        .findOne({ commentId: record.key })
        .select({ purgedAt: 1 })
        .lean()
        .exec();
      return row?.purgedAt instanceof Date ? 'content' : 'invalid';
    }
    if (contentShape) {
      return (await this.pagePurged(record.key)) ? 'content' : 'invalid';
    }
    const suggesterShape =
      record.text !== '' &&
      record.authorUserId !== PURGED_PERSON &&
      record.suggestedBy === undefined &&
      record.suggestionId !== undefined;
    if (!suggesterShape || !(await this.suggestionBound(record))) {
      return 'invalid';
    }
    const redacted = await this.redaction(record);
    if (redacted === 'mismatch') return 'invalid';
    return redacted === 'anchored' ? 'suggester' : 'suggester-pending';
  }
}
