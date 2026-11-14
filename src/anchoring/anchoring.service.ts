import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, PipelineStage, QueryFilter, Types } from 'mongoose';
import {
  BlockVersion,
  type BlockVersionDocument,
} from '../social/schemas/block-version.schema';
import {
  CommentVersion,
  type CommentVersionDocument,
} from '../social/schemas/comment-version.schema';
import { asBytes } from './bytes';
import { buildTree, leafHash, MERKLE_SCHEME } from './merkle';
import {
  mergeInto,
  nodeFor,
  parseDetached,
  serializeDetached,
  summarize,
  type TimestampNode,
} from './ots';
import { OtsProvider, TsaProvider } from './providers';
import {
  AnchorLeaf,
  type AnchorLeafDocument,
  type AnchoredKind,
  leafId,
  RELEASE_STRAY_CLAIMS,
} from './schemas/anchor-leaf.schema';
import {
  type AnchoredLeaf,
  TimestampAnchor,
  type TimestampAnchorDocument,
} from './schemas/timestamp-anchor.schema';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Versions younger than this wait for the next anchor (inserts in flight). */
export const SETTLE_MS = 2 * MINUTE_MS;
/**
 * How far before the last anchor's cutoff a new batch still looks, for a
 * version whose insert landed after that anchor was built.
 */
export const LOOKBACK_MS = DAY_MS;
/** Most versions in one day's batch; the rest wait for the next day. */
export const MAX_LEAVES = 50_000;
/** How long a builder holds a day's anchor. */
export const BUILD_LEASE_MS = 10 * MINUTE_MS;
/** How long one provider step holds its anchor. */
export const STEP_LEASE_MS = 5 * MINUTE_MS;
/** How often a pending OpenTimestamps proof is asked about (etiquette). */
export const UPGRADE_INTERVAL_MS = 6 * HOUR_MS;
/** Longest wait between retries of a failed provider. */
export const MAX_RETRY_DELAY_MS = DAY_MS;

/** 1 h after the first failure, doubling, at most a day. */
export function retryDelay(attempts: number): number {
  return Math.min(HOUR_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_DELAY_MS);
}

/** The anchor id for a moment: its UTC date. */
export function anchorDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

type AnchorFilter = QueryFilter<TimestampAnchor>;

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

/** Duplicate-key errors from an unordered insert are expected; others not. */
function onlyDuplicates(error: unknown): boolean {
  const writeErrors = (error as { writeErrors?: unknown } | null)?.writeErrors;
  return (
    Array.isArray(writeErrors) &&
    writeErrors.length > 0 &&
    writeErrors.every(
      (entry) =>
        ((entry as { code?: unknown; err?: { code?: unknown } }).code ??
          (entry as { err?: { code?: unknown } }).err?.code) === 11000,
    )
  );
}

export type BuildOutcome =
  | { state: 'not-due' | 'nothing-new' | 'busy' }
  | { state: 'failed'; anchorId: string; error: string }
  | { state: 'already-built' | 'empty'; anchorId: string }
  | { state: 'built'; anchorId: string; leaves: number };

export interface StepOutcome {
  anchorId: string;
  outcome: string;
}

export interface RunReport {
  /** Builds of earlier days that had died part-way, finished now (review H1). */
  resumed: BuildOutcome[];
  build: BuildOutcome;
  tsa: StepOutcome[];
  ots: StepOutcome[];
}

interface Candidate {
  _id: Types.ObjectId;
  hash: string;
  createdAt: Date;
}

/**
 * The daily anchor (plan §6, Chunk 16): once a day, a Merkle root over every
 * belief and comment version not yet anchored, time-stamped by FreeTSA
 * (RFC 3161) and by OpenTimestamps (Bitcoin), each on its own.
 *
 * Safe with any number of server instances, without transactions:
 * - one anchor a day: its `_id` is the date;
 * - one anchor per version, ever: the `anchorleaves` row's `_id` names the
 *   version, so a second claim is a duplicate key;
 * - every step (building, each provider) holds a lease, and its result is
 *   written only while that lease is still its own; a crashed holder's
 *   lease runs out and the next run takes over.
 *
 * Only hashes leave the server: the root to both providers, then the
 * calendars' own commitments to ask for upgrades.
 */
@Injectable()
export class AnchoringService {
  private readonly logger = new Logger(AnchoringService.name);
  /** Pause between the tries of one provider (tests set it to 0). */
  retryPauseMs?: number;
  /** Most versions in one day's batch (tests set a small one). */
  maxLeaves = MAX_LEAVES;

  constructor(
    @InjectModel(TimestampAnchor.name)
    private readonly anchorModel: Model<TimestampAnchorDocument>,
    @InjectModel(AnchorLeaf.name)
    private readonly leafModel: Model<AnchorLeafDocument>,
    @InjectModel(BlockVersion.name)
    private readonly blockVersionModel: Model<BlockVersionDocument>,
    @InjectModel(CommentVersion.name)
    private readonly commentVersionModel: Model<CommentVersionDocument>,
    private readonly tsa: TsaProvider,
    private readonly ots: OtsProvider,
  ) {}

  get enabled() {
    return this.tsa.settings.enabled;
  }

  /**
   * Everything that is due: today's anchor (from the configured hour, or at
   * once with `force`), then any provider step waiting or to retry, then
   * OpenTimestamps upgrades.
   */
  async run(now = new Date(), force = false): Promise<RunReport> {
    const resumed = await this.resumeStale(now);
    const build = await this.build(now, force);
    const report: RunReport = { resumed, build, tsa: [], ots: [] };
    for (const id of await this.due('tsa', now)) {
      report.tsa.push({ anchorId: id, outcome: await this.stampTsa(id, now) });
    }
    for (const id of await this.due('ots', now)) {
      report.ots.push({ anchorId: id, outcome: await this.stampOts(id, now) });
    }
    return report;
  }

  /** Today's batch, if due and not made yet. */
  async build(now: Date, force = false): Promise<BuildOutcome> {
    if (!force && now.getUTCHours() < this.tsa.settings.hourUtc) {
      return { state: 'not-due' };
    }
    const day = anchorDay(now);
    const existing = await this.anchorModel
      .findById(day)
      .select({ status: 1 })
      .lean()
      .exec();
    if (existing && existing.status !== 'building') {
      return {
        state: existing.status === 'built' ? 'already-built' : 'empty',
        anchorId: day,
      };
    }
    const lease = {
      id: randomUUID(),
      until: new Date(now.getTime() + BUILD_LEASE_MS),
    };
    if (existing) {
      const taken = await this.anchorModel
        .findOneAndUpdate(
          {
            _id: day,
            status: 'building',
            // No lease at all is as stale as a run-out one (review L-b).
            $or: [
              { lease: { $exists: false } },
              { 'lease.until': { $lt: now } },
            ],
          } as AnchorFilter,
          { $set: { lease } },
        )
        .lean()
        .exec();
      if (!taken) return { state: 'busy' };
    } else {
      const cutoff = new Date(now.getTime() - SETTLE_MS);
      const lower = await this.lowerBound();
      if ((await this.unclaimed(lower, cutoff, 1)).length === 0) {
        return { state: 'nothing-new' };
      }
      try {
        await this.anchorModel.create({
          _id: day,
          status: 'building',
          lease,
          cutoff,
        });
      } catch (error) {
        if (isDuplicateKey(error)) return { state: 'busy' };
        throw error;
      }
    }
    return this.finishBuild(day, lease.id, now);
  }

  /**
   * Finishes every build of an EARLIER day whose builder died after claiming
   * its versions (review H1): its lease ran out, so it is taken over and
   * built from its own claims. Today's is left to `build`.
   */
  private async resumeStale(now: Date): Promise<BuildOutcome[]> {
    const stale = await this.anchorModel
      .find({
        status: 'building',
        _id: { $lt: anchorDay(now) },
        $or: [{ lease: { $exists: false } }, { 'lease.until': { $lt: now } }],
      } as AnchorFilter)
      .sort({ _id: 1 })
      .select({ _id: 1 })
      .lean()
      .exec();
    const outcomes: BuildOutcome[] = [];
    for (const { _id } of stale) {
      const lease = {
        id: randomUUID(),
        until: new Date(now.getTime() + BUILD_LEASE_MS),
      };
      // Each on its own: one that cannot be finished stops nothing else
      // (review M-B). It stays stale, so the next run tries again.
      try {
        const taken = await this.anchorModel
          .findOneAndUpdate(
            {
              _id,
              status: 'building',
              $or: [
                { lease: { $exists: false } },
                { 'lease.until': { $lt: now } },
              ],
            } as AnchorFilter,
            { $set: { lease } },
          )
          .lean()
          .exec();
        if (taken) {
          outcomes.push(await this.finishBuild(String(_id), lease.id, now));
        }
      } catch (error) {
        const reason = describe(error);
        this.logger.error(
          `Anchor ${String(_id)}: resuming failed (${reason}).`,
        );
        outcomes.push({
          state: 'failed',
          anchorId: String(_id),
          error: reason,
        });
      }
    }
    return outcomes;
  }

  /**
   * Where a new batch starts looking. The latest built anchor's cutoff less
   * the look-back; but when that anchor was capped, from the oldest version
   * it had to leave (`resumeFrom`), so no version ever falls outside every
   * window (review M1). The first batch looks at all history.
   */
  private async lowerBound(): Promise<Date> {
    const last = await this.anchorModel
      .findOne({ status: 'built' })
      .sort({ _id: -1 })
      .select({ cutoff: 1, resumeFrom: 1 })
      .lean()
      .exec();
    if (!last?.cutoff) return new Date(0);
    const lookBack = last.cutoff.getTime() - LOOKBACK_MS;
    return new Date(
      last.resumeFrom
        ? Math.min(lookBack, last.resumeFrom.getTime() - 1)
        : lookBack,
    );
  }

  /** Versions of both kinds in (lower, cutoff] that no anchor has claimed. */
  private async unclaimed(
    lower: Date,
    cutoff: Date,
    limit: number,
  ): Promise<Array<Candidate & { kind: AnchoredKind }>> {
    const pipeline = (max: number): PipelineStage[] => [
      { $match: { createdAt: { $gt: lower, $lte: cutoff } } },
      { $sort: { createdAt: 1, _id: 1 } },
      {
        $lookup: {
          from: 'anchorleaves',
          localField: '_id',
          foreignField: 'versionId',
          pipeline: [{ $project: { _id: 1 } }],
          as: 'claims',
        },
      },
      { $match: { claims: { $size: 0 } } },
      { $limit: max },
      { $project: { _id: 1, hash: 1, createdAt: 1 } },
    ];
    // Both kinds, merged oldest first, so neither can starve the other
    // (review M1). One more than the limit says whether the cap was hit.
    const blocks = await this.blockVersionModel
      .aggregate<Candidate>(pipeline(limit + 1))
      .exec();
    const comments = await this.commentVersionModel
      .aggregate<Candidate>(pipeline(limit + 1))
      .exec();
    return [
      ...blocks.map((row) => ({ ...row, kind: 'block' as const })),
      ...comments.map((row) => ({ ...row, kind: 'comment' as const })),
    ]
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          String(a._id).localeCompare(String(b._id)),
      )
      .slice(0, limit + 1);
  }

  private async finishBuild(
    day: string,
    leaseId: string,
    now: Date,
  ): Promise<BuildOutcome> {
    const row = (await this.anchorModel
      .findById(day)
      .select({ cutoff: 1 })
      .lean()
      .exec()) as { cutoff: Date };
    // A takeover keeps the claims a dead builder made: only the rest of
    // the cap is claimed now, so retries never grow one anchor (review M-B).
    const held = await this.leafModel.countDocuments({ anchorId: day }).exec();
    const budget = Math.max(0, this.maxLeaves - held);
    const found = await this.unclaimed(
      await this.lowerBound(),
      row.cutoff,
      budget,
    );
    const candidates = found.slice(0, budget);
    // Capped: the oldest version left behind is where the next batch starts.
    const left = found.at(budget);
    const owned: AnchorFilter = {
      _id: day,
      status: 'building',
      'lease.id': leaseId,
    };
    // Still ours? A builder whose lease was taken over claims nothing
    // (review L-a).
    const stillOurs = await this.anchorModel
      .findOne(owned)
      .select({ _id: 1 })
      .lean()
      .exec();
    if (!stillOurs) return { state: 'busy' };
    if (candidates.length > 0) {
      try {
        await this.leafModel.insertMany(
          candidates.map((candidate) => ({
            _id: leafId(candidate.kind, candidate._id),
            anchorId: day,
            kind: candidate.kind,
            versionId: candidate._id,
            versionHash: candidate.hash,
            versionCreatedAt: candidate.createdAt,
            salt: randomBytes(32).toString('hex'),
            // Which builder wrote it (review round 3, L-1).
            leaseId,
          })),
          { ordered: false },
        );
      } catch (error) {
        // Claimed meanwhile by another day's batch: not ours, and not lost.
        if (!onlyDuplicates(error)) throw error;
      }
      // Our lease may have run out during the insert (review round 4,
      // LOW-1): then a takeover may already have built or emptied this
      // anchor without our claims. Whoever holds the lease now handles
      // claims that land while it builds; one that lands after it finished
      // is released here, so the version can be claimed again.
      const stillOursAfter = await this.anchorModel
        .findOne(owned)
        .select({ _id: 1 })
        .lean()
        .exec();
      if (!stillOursAfter) {
        await this.releaseStray(day);
        return { state: 'busy' };
      }
    }
    const claims = (await this.leafModel
      .find({ anchorId: day })
      .select({ kind: 1, versionId: 1, versionHash: 1, salt: 1 })
      .lean()
      .exec()) as Array<Omit<AnchoredLeaf, 'leaf'> & { salt: string }>;
    if (claims.length === 0) {
      const done = await this.anchorModel
        .updateOne(owned, { $set: { status: 'empty' }, $unset: { lease: 1 } })
        .exec();
      if (done.modifiedCount !== 1) return { state: 'busy' };
      await this.releaseStray(day);
      return { state: 'empty', anchorId: day };
    }
    const leaves = claims
      .map((claim) => ({
        kind: claim.kind,
        versionId: claim.versionId,
        versionHash: claim.versionHash,
        leaf: leafHash(claim.versionHash, claim.salt),
      }))
      .sort((a, b) =>
        `${a.kind}:${String(a.versionId)}`.localeCompare(
          `${b.kind}:${String(b.versionId)}`,
        ),
      );
    const tree = buildTree(leaves.map((entry) => entry.leaf));
    // A claim that landed after our read (a builder whose lease ran out)
    // would be outside the tree: then the anchor is not marked built, and
    // the next takeover builds it with that claim (review round 3, L-1).
    const recount = await this.leafModel
      .countDocuments({ anchorId: day })
      .exec();
    if (recount !== leaves.length) return { state: 'busy' };
    const done = await this.anchorModel
      .updateOne(owned, {
        $set: {
          status: 'built',
          scheme: MERKLE_SCHEME,
          merkleRoot: tree.root,
          leaves,
          leafCount: leaves.length,
          builtAt: now,
          ...(left ? { resumeFrom: left.createdAt } : {}),
          tsa: { status: 'pending', attempts: 0 },
          ots: { status: 'submit', attempts: 0 },
        },
        $unset: { lease: 1 },
      })
      .exec();
    if (done.modifiedCount !== 1) return { state: 'busy' };
    // A claim that landed between the recount and the update slipped past
    // the guard: release it (review round 4, LOW-1).
    await this.releaseStray(day);
    this.logger.log(
      `Anchor ${day}: ${leaves.length} versions, root ${tree.root}`,
    );
    return { state: 'built', anchorId: day, leaves: leaves.length };
  }

  /**
   * Deletes the claims of a FINISHED anchor that are not in its tree, so
   * no version stays claimed but outside every tree (review round 4,
   * LOW-1). Such a claim can only come from a builder whose lease ran out
   * mid-insert. While the anchor is still building nothing is touched: its
   * lease holder reads every claim before building, and its recount turns
   * any later one into a takeover.
   */
  private async releaseStray(day: string): Promise<void> {
    const row = (await this.anchorModel
      .findById(day)
      .select({ status: 1, leaves: 1 })
      .lean()
      .exec()) as Pick<TimestampAnchor, 'status' | 'leaves'>;
    if (row.status === 'building') return;
    const kept = (row.leaves ?? []).map((entry) =>
      leafId(entry.kind, entry.versionId),
    );
    const { deletedCount } = await this.leafModel
      .deleteMany({ anchorId: day, _id: { $nin: kept } })
      .setOptions({ [RELEASE_STRAY_CLAIMS]: true })
      .exec();
    if (deletedCount > 0) {
      this.logger.warn(
        `Anchor ${day}: released ${deletedCount} claim(s) that a builder made after the tree was built; they will be anchored in a later batch.`,
      );
    }
  }

  /** Built anchors whose provider step is waiting or due to retry. */
  private async due(step: 'tsa' | 'ots', now: Date): Promise<string[]> {
    const waiting =
      step === 'tsa'
        ? { 'tsa.status': { $in: ['pending', 'failed'] } }
        : { 'ots.status': { $in: ['submit', 'failed', 'pending'] } };
    const filter = {
      status: 'built',
      ...waiting,
      $or: [
        { [`${step}.nextAttemptAt`]: { $exists: false } },
        { [`${step}.nextAttemptAt`]: { $lte: now } },
      ],
    } as AnchorFilter;
    const rows = await this.anchorModel
      .find(filter)
      .sort({ _id: 1 })
      .select({ _id: 1 })
      .lean()
      .exec();
    return rows.map((row) => String(row._id));
  }

  /**
   * Takes a provider step's lease on one anchor.
   *
   * @returns the lease id and the anchor, or undefined if someone holds it
   *   or the step is done
   */
  private async takeStep(id: string, step: 'tsa' | 'ots', now: Date) {
    const leaseId = randomUUID();
    const open =
      step === 'tsa'
        ? { 'tsa.status': { $ne: 'granted' } }
        : { 'ots.status': { $ne: 'confirmed' } };
    const anchor = await this.anchorModel
      .findOneAndUpdate(
        {
          _id: id,
          status: 'built',
          ...open,
          $or: [
            { [`${step}.lease`]: { $exists: false } },
            { [`${step}.lease.until`]: { $lt: now } },
          ],
        } as AnchorFilter,
        {
          $set: {
            [`${step}.lease`]: {
              id: leaseId,
              until: new Date(now.getTime() + STEP_LEASE_MS),
            },
          },
        },
        { returnDocument: 'after' },
      )
      .lean()
      .exec();
    return anchor ? { leaseId, anchor } : undefined;
  }

  /** Writes a step's result only while the lease is still this run's. */
  private async finishStep(
    id: string,
    step: 'tsa' | 'ots',
    leaseId: string,
    update: { $set: Record<string, unknown>; $inc?: Record<string, number> },
  ): Promise<boolean> {
    const done = await this.anchorModel
      .updateOne({ _id: id, [`${step}.lease.id`]: leaseId } as AnchorFilter, {
        ...update,
        $unset: { [`${step}.lease`]: 1 },
      })
      .exec();
    return done.modifiedCount === 1;
  }

  private async stampTsa(id: string, now: Date): Promise<string> {
    const taken = await this.takeStep(id, 'tsa', now);
    if (!taken) return 'busy';
    const { leaseId, anchor } = taken;
    const attempts = (anchor.tsa?.attempts ?? 0) + 1;
    try {
      const token = await this.tsa.timestamp(
        anchor.merkleRoot as string,
        this.retryPauseMs,
      );
      const kept = await this.finishStep(id, 'tsa', leaseId, {
        $set: {
          'tsa.status': 'granted',
          'tsa.attempts': attempts,
          'tsa.response': token.response,
          'tsa.genTime': token.tst.genTime,
          'tsa.serial': token.tst.serial,
          'tsa.nextAttemptAt': null,
          'tsa.lastError': null,
        },
      });
      return kept ? 'granted' : 'lease-lost';
    } catch (error) {
      const reason = describe(error);
      this.logger.warn(`Anchor ${id}: FreeTSA failed (${reason}); will retry.`);
      await this.finishStep(id, 'tsa', leaseId, {
        $set: {
          'tsa.status': 'failed',
          'tsa.attempts': attempts,
          'tsa.lastError': reason,
          'tsa.nextAttemptAt': new Date(now.getTime() + retryDelay(attempts)),
        },
      });
      return 'failed';
    }
  }

  private async stampOts(id: string, now: Date): Promise<string> {
    const taken = await this.takeStep(id, 'ots', now);
    if (!taken) return 'busy';
    const { leaseId, anchor } = taken;
    const proof = asBytes(anchor.ots?.proof);
    return anchor.ots?.status === 'pending' && proof
      ? this.upgradeOts(id, leaseId, proof, now)
      : this.submitOts(id, leaseId, anchor, now);
  }

  private async submitOts(
    id: string,
    leaseId: string,
    anchor: TimestampAnchor,
    now: Date,
  ): Promise<string> {
    const root = anchor.merkleRoot as string;
    const attempts = (anchor.ots?.attempts ?? 0) + 1;
    const answers = await this.ots.submit(root, this.retryPauseMs);
    const calendars = answers.map(({ url, ok, error }) => ({
      url,
      ok,
      ...(error ? { error } : {}),
    }));
    const accepted = answers.filter((answer) => answer.tree);
    if (accepted.length === 0) {
      this.logger.warn(
        `Anchor ${id}: no OpenTimestamps calendar answered; will retry.`,
      );
      await this.finishStep(id, 'ots', leaseId, {
        $set: {
          'ots.status': 'failed',
          'ots.attempts': attempts,
          'ots.calendars': calendars,
          'ots.lastError': 'no calendar accepted the root',
          'ots.nextAttemptAt': new Date(now.getTime() + retryDelay(attempts)),
        },
      });
      return 'failed';
    }
    const digest = Buffer.from(root, 'hex');
    const tree: TimestampNode = { msg: digest, attestations: [], ops: [] };
    for (const answer of accepted)
      mergeInto(tree, answer.tree as TimestampNode);
    const kept = await this.finishStep(id, 'ots', leaseId, {
      $set: {
        'ots.status': 'pending',
        'ots.attempts': attempts,
        'ots.calendars': calendars,
        'ots.proof': serializeDetached(digest, tree),
        'ots.lastError': null,
        'ots.nextAttemptAt': new Date(now.getTime() + UPGRADE_INTERVAL_MS),
      },
    });
    return kept ? 'pending' : 'lease-lost';
  }

  private async upgradeOts(
    id: string,
    leaseId: string,
    proof: Buffer,
    now: Date,
  ): Promise<string> {
    const { digest, tree } = parseDetached(proof);
    const problems: string[] = [];
    for (const { uri, commitment } of summarize(tree).pending) {
      try {
        const answer = await this.ots.upgrade(uri, commitment);
        if (answer.state === 'upgraded') {
          mergeInto(nodeFor(tree, commitment) as TimestampNode, answer.tree);
        } else if (answer.state === 'refused') {
          problems.push(`${uri}: ${answer.reason}`);
        }
      } catch (error) {
        problems.push(`${uri}: ${describe(error)}`);
      }
      // One Bitcoin attestation is a complete proof; ask no further.
      if (summarize(tree).bitcoin.length > 0) break;
    }
    const heights = summarize(tree).bitcoin.map((entry) => entry.height);
    const confirmed = heights.length > 0;
    const kept = await this.finishStep(id, 'ots', leaseId, {
      $set: {
        'ots.status': confirmed ? 'confirmed' : 'pending',
        'ots.proof': serializeDetached(digest, tree),
        'ots.lastUpgradeAt': now,
        'ots.lastError': problems.length > 0 ? problems.join('; ') : null,
        'ots.nextAttemptAt': confirmed
          ? null
          : new Date(now.getTime() + UPGRADE_INTERVAL_MS),
        ...(confirmed ? { 'ots.bitcoinHeights': heights } : {}),
      },
    });
    if (!kept) return 'lease-lost';
    return confirmed ? 'confirmed' : 'pending';
  }

  /** The anchor and claim of one version, if it has been anchored. */
  async anchorOf(kind: AnchoredKind, versionId: Types.ObjectId | string) {
    const claim = await this.leafModel
      .findById(leafId(kind, versionId))
      .lean()
      .exec();
    if (!claim) return undefined;
    const anchor = await this.anchorModel
      .findOne({ _id: claim.anchorId, status: 'built' })
      .lean()
      .exec();
    return anchor ? { claim, anchor } : undefined;
  }
}
