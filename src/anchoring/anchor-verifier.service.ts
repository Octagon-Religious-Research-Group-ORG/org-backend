import { createHash, X509Certificate } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter, Types } from 'mongoose';
import {
  BlockVersion,
  type BlockVersionDocument,
} from '../social/schemas/block-version.schema';
import {
  CommentVersion,
  type CommentVersionDocument,
} from '../social/schemas/comment-version.schema';
import { withBytes } from './bytes';
import { FREETSA_ROOT_PEM } from './freetsa-certs';
import { buildTree, leafHash, type PathStep, rootFromPath } from './merkle';
import { parseDetached, summarize } from './ots';
import { parseTimestampResponse, verifyTimestampToken } from './rfc3161';
import {
  AnchorLeaf,
  type AnchorLeafDocument,
  type AnchoredKind,
  leafId,
} from './schemas/anchor-leaf.schema';
import {
  type AnchoredLeaf,
  TimestampAnchor,
  type TimestampAnchorDocument,
} from './schemas/timestamp-anchor.schema';
import {
  type RawVersionRow,
  recomputeHash,
  toRecord,
  type VersionRecord,
  VERSION_PROJECTION,
} from './version-records';

/** Three outcomes, never two (Rule: "cannot verify" is not a pass). */
export type Outcome = 'pass' | 'fail' | 'cannot-measure';

export interface Check {
  outcome: Outcome;
  detail: string;
  /** Versions check only: it failed on the claim count and nothing else. */
  claimCountOnly?: true;
}

export interface AnchorReport {
  anchorId: string;
  status: string;
  leaves: number;
  /** The stored root equals the root rebuilt from the stored leaves. */
  root: Check;
  /** Every leaf's version exists, rehashes to its hash, and is claimed here. */
  versions: Check;
  tsa: Check;
  ots: Check;
  /** The Bitcoin block itself: needs a Bitcoin node, which we do not have. */
  bitcoin: Check;
}

export interface HealthReport {
  checkedAt: string;
  page: number;
  hasMore: boolean;
  /** `totals` count this page's anchors only. */
  totalsScope: 'page';
  global: {
    anchors: number;
    unfinished: number;
    failedWhenLastChecked: number;
    neverChecked: number;
    cannotMeasureWhenLastChecked: number;
    /** ISO time of the oldest stored check, or null when none is stored. */
    oldestCheck: string | null;
  };
  anchors: AnchorReport[];
  /** Versions older than the newest anchor's cutoff that no anchor holds. */
  coverage: Check;
  /** Per check, how many anchors passed, failed, or could not be measured. */
  totals: Record<
    'root' | 'versions' | 'tsa' | 'ots' | 'bitcoin',
    Record<Outcome, number>
  >;
}

/** What a receipt says about one version's anchoring. */
export type VersionProof =
  | { anchored: false }
  | {
      anchored: true;
      anchorId: string;
      leaf: string;
      /** The version's secret salt: for readers who may know the author only. */
      salt?: string;
      path: PathStep[];
      root: string;
      anchor: TimestampAnchor;
      checks: {
        hash: Check;
        path: Check;
        tsa: Check;
        ots: Check;
      };
    };

/**
 * Most leaves the receipt cache holds, over all its anchors (review L-c): a
 * tree costs memory per leaf, so the bound is on leaves, not anchors.
 */
export const ANCHOR_CACHE_LEAVES = 200_000;
/** Anchors per page of the admin health view. */
export const ANCHORS_PAGE_SIZE = 30;

const pass = (detail: string): Check => ({ outcome: 'pass', detail });
const fail = (detail: string): Check => ({ outcome: 'fail', detail });
const unknown = (detail: string): Check => ({
  outcome: 'cannot-measure',
  detail,
});

type AnchorQuery = QueryFilter<TimestampAnchor>;

/** The worst outcome of an anchor's checks, the Bitcoin block aside. */
function worstOf(report: AnchorReport): Outcome {
  const outcomes = [report.root, report.versions, report.tsa, report.ots].map(
    (check) => check.outcome,
  );
  if (outcomes.includes('fail')) return 'fail';
  return outcomes.includes('cannot-measure') ? 'cannot-measure' : 'pass';
}

/**
 * Failed on its claim count and on nothing else (review round 5): the only
 * failure the sweep may repair by releasing claims.
 */
function claimCountOnly(report: AnchorReport): boolean {
  return (
    report.versions.claimCountOnly === true &&
    [report.root, report.tsa, report.ots].every(
      (check) => check.outcome !== 'fail',
    )
  );
}

/** The salted leaf of a claim, or undefined for a malformed one. */
function saltedLeaf(versionHash: string, salt: string | undefined) {
  try {
    return leafHash(versionHash, String(salt));
  } catch {
    return undefined;
  }
}

/** The tree the leaves give, or undefined when they give none. */
function safeTree(leaves: readonly AnchoredLeaf[]) {
  try {
    return buildTree(leaves.map((leaf) => leaf.leaf));
  } catch {
    return undefined;
  }
}

function rebuildRoot(leaves: readonly AnchoredLeaf[]): string | undefined {
  return safeTree(leaves)?.root;
}

/** Checks a stored TimeStampResp against a root and the pinned FreeTSA root. */
export function checkTsa(
  response: Buffer | undefined,
  root: string,
  roots: readonly X509Certificate[],
): Check {
  if (!response) return unknown('no FreeTSA token yet');
  let token: Buffer | undefined;
  try {
    token = parseTimestampResponse(response).token;
  } catch (error) {
    return fail((error as Error).message);
  }
  if (!token) return fail('the response holds no token');
  const verdict = verifyTimestampToken(token, root, roots);
  return verdict.outcome === 'pass'
    ? pass(`signed by FreeTSA at ${verdict.tst.genTime.toISOString()}`)
    : { outcome: verdict.outcome, detail: verdict.reason };
}

/** Checks a stored .ots proof commits to the root, and what it reaches. */
export function checkOts(
  proof: Buffer | undefined,
  root: string,
): { ots: Check; bitcoin: Check } {
  if (!proof) {
    return {
      ots: unknown('no OpenTimestamps proof yet'),
      bitcoin: unknown('no proof yet'),
    };
  }
  try {
    const { digest, tree } = parseDetached(proof);
    if (digest.toString('hex') !== root) {
      return {
        ots: fail('the proof is for another digest'),
        bitcoin: unknown('proof is for another digest'),
      };
    }
    const summary = summarize(tree);
    if (summary.pending.length === 0 && summary.bitcoin.length === 0) {
      // Commits to the root, but nobody attests it (review L3).
      return {
        ots: unknown('the proof commits to the root but holds no attestation'),
        bitcoin: unknown('no attestation'),
      };
    }
    return {
      ots: pass(
        `commits to the root; ${summary.pending.length} calendar(s) pending, ${summary.bitcoin.length} Bitcoin attestation(s)`,
      ),
      bitcoin:
        summary.bitcoin.length > 0
          ? unknown(
              `claims block ${summary.bitcoin.map((b) => b.height).join(', ')}; the block header is not checked here (no Bitcoin node): check with the ots client`,
            )
          : unknown('not yet in Bitcoin (calendars pending)'),
    };
  } catch (error) {
    return {
      ots: fail(`unreadable proof: ${(error as Error).message}`),
      bitcoin: unknown('unreadable proof'),
    };
  }
}

/**
 * Verifies anchors (Chunk 16) from what is stored, without trusting any of
 * it: versions are rehashed from their fields, roots rebuilt from leaves,
 * tokens checked against the pinned FreeTSA root, proofs re-read.
 *
 * Tampering this detects: an edited version (its fields no longer give its
 * hash), a rewritten version with a recomputed hash (no longer the anchored
 * leaf), an edited leaf list or root (the root no longer rebuilds, or no
 * longer matches the token's imprint), a replaced token or proof.
 */
@Injectable()
export class AnchorVerifierService {
  /** The only trust anchor: FreeTSA's root (tests pin their own). */
  trustedRoots = [new X509Certificate(FREETSA_ROOT_PEM)];
  /** How many leaves the receipt cache may hold (tests set a small one). */
  anchorCacheLeaves = ANCHOR_CACHE_LEAVES;
  private cachedLeaves = 0;
  private readonly anchorChecks = new Map<
    string,
    {
      tree: ReturnType<typeof safeTree>;
      tsa: Check;
      ots: Check;
      size: number;
    }
  >();

  constructor(
    @InjectModel(TimestampAnchor.name)
    private readonly anchorModel: Model<TimestampAnchorDocument>,
    @InjectModel(AnchorLeaf.name)
    private readonly leafModel: Model<AnchorLeafDocument>,
    @InjectModel(BlockVersion.name)
    private readonly blockVersionModel: Model<BlockVersionDocument>,
    @InjectModel(CommentVersion.name)
    private readonly commentVersionModel: Model<CommentVersionDocument>,
  ) {}

  private modelOf(kind: AnchoredKind): Model<unknown> {
    return (
      kind === 'block' ? this.blockVersionModel : this.commentVersionModel
    ) as Model<unknown>;
  }

  /** Version rows by id, of one kind. */
  private async records(
    kind: AnchoredKind,
    ids: Types.ObjectId[],
  ): Promise<Map<string, VersionRecord>> {
    if (ids.length === 0) return new Map();
    const rows = (await this.modelOf(kind)
      .find({ _id: { $in: ids } })
      .select(VERSION_PROJECTION)
      .lean()
      .exec()) as unknown as RawVersionRow[];
    return new Map(rows.map((row) => [String(row._id), toRecord(kind, row)]));
  }

  private async checkVersions(
    anchorId: string,
    leaves: AnchoredLeaf[],
  ): Promise<Check> {
    const claims = (await this.leafModel
      .find({ anchorId })
      .select({ versionHash: 1, salt: 1 })
      .lean()
      .exec()) as Array<{ _id: string; versionHash: string; salt: string }>;
    const claimed = new Map(
      claims.map((claim) => [claim._id, claim.versionHash]),
    );
    const saltOf = new Map(claims.map((claim) => [claim._id, claim.salt]));
    const problems: string[] = [];
    if (claimed.size !== leaves.length) {
      problems.push(`${claimed.size} claims for ${leaves.length} leaves`);
    }
    const byKind = {
      block: await this.records(
        'block',
        leaves.filter((l) => l.kind === 'block').map((l) => l.versionId),
      ),
      comment: await this.records(
        'comment',
        leaves.filter((l) => l.kind === 'comment').map((l) => l.versionId),
      ),
    };
    for (const leaf of leaves) {
      const id = leafId(leaf.kind, leaf.versionId);
      const record = byKind[leaf.kind].get(String(leaf.versionId));
      if (claimed.get(id) !== leaf.versionHash) {
        problems.push(`${id}: not claimed by this anchor with this hash`);
      } else if (saltedLeaf(leaf.versionHash, saltOf.get(id)) !== leaf.leaf) {
        problems.push(`${id}: its salted leaf does not match its claim`);
      } else if (!record) {
        problems.push(`${id}: version missing`);
      } else if (record.hash !== leaf.versionHash) {
        problems.push(`${id}: stored hash differs from the anchored one`);
      } else if (recomputeHash(leaf.kind, record) !== record.hash) {
        problems.push(`${id}: its fields no longer give its hash`);
      }
    }
    if (problems.length === 0) {
      return pass(
        `${leaves.length} version(s) rehash to their anchored leaves`,
      );
    }
    const countOnly = problems.length === 1 && claimed.size !== leaves.length;
    return {
      ...fail(problems.slice(0, 20).join('; ')),
      ...(countOnly ? { claimCountOnly: true as const } : {}),
    };
  }

  /** An empty anchor with no claim and no reach-back point on it. */
  private async nothingOn(anchor: TimestampAnchor): Promise<boolean> {
    if (anchor.rescanFrom !== undefined || anchor.resumeOpen === true) {
      return false;
    }
    return (
      (await this.leafModel.countDocuments({ anchorId: anchor._id }).exec()) ===
      0
    );
  }

  /** Every check on one anchor row. */
  async verifyAnchor(stored: TimestampAnchor): Promise<AnchorReport> {
    const anchor = withBytes(stored);
    const leaves = anchor.leaves ?? [];
    const base = {
      anchorId: anchor._id,
      status: anchor.status,
      leaves: leaves.length,
    };
    if (anchor.status === 'empty' && (await this.nothingOn(anchor))) {
      // Nothing to anchor that day: a pass, not noise (review round 7).
      const nothing = pass('nothing to anchor');
      return {
        ...base,
        root: nothing,
        versions: nothing,
        tsa: nothing,
        ots: nothing,
        bitcoin: nothing,
      };
    }
    if (anchor.status !== 'built') {
      const note = unknown(
        anchor.status === 'empty'
          ? 'empty, but it holds claims or a reach-back point'
          : 'still being built',
      );
      return {
        ...base,
        root: note,
        versions: note,
        tsa: note,
        ots: note,
        bitcoin: note,
      };
    }
    // A built anchor without a root was changed after it was built.
    const root = anchor.merkleRoot ?? '';
    const rootCheck =
      rebuildRoot(leaves) === root
        ? pass('the leaves rebuild the stored root')
        : fail('the leaves do not rebuild the stored root');
    return {
      ...base,
      root: rootCheck,
      versions: await this.checkVersions(anchor._id, leaves),
      tsa: checkTsa(anchor.tsa?.response, root, this.trustedRoots),
      ...checkOts(anchor.ots?.proof, root),
    };
  }

  /**
   * Claims whose anchor is not built: a build that died part-way, or an
   * anchor row that went missing (review H1). A build still holding its
   * lease is in progress, not a problem.
   */
  private async unfinishedClaims(now: Date): Promise<string[]> {
    const counted = await this.leafModel
      .aggregate<{
        _id: string;
        n: number;
      }>([{ $group: { _id: '$anchorId', n: { $sum: 1 } } }])
      .exec();
    if (counted.length === 0) return [];
    const anchorIds = counted.map((entry) => entry._id);
    const rows = (await this.anchorModel
      .find({ _id: { $in: anchorIds } })
      .select({ status: 1, lease: 1, leafCount: 1 })
      .lean()
      .exec()) as TimestampAnchor[];
    // A built anchor must hold exactly its claims (review L-a): a claim it
    // does not hold was never anchored.
    const claimsOf = new Map(counted.map((entry) => [entry._id, entry.n]));
    const mismatched = rows
      .filter(
        (row) =>
          row.status === 'built' && row.leafCount !== claimsOf.get(row._id),
      )
      .map(
        (row) =>
          `anchor ${row._id} has ${claimsOf.get(row._id)} claims for ${row.leafCount ?? 'no recorded'} leaves`,
      );
    const fine = new Set(
      rows
        .filter(
          (row) =>
            row.status === 'built' ||
            (row.status === 'building' &&
              row.lease !== undefined &&
              row.lease.until.getTime() >= now.getTime()),
        )
        .map((row) => row._id),
    );
    const unfinished = anchorIds.filter((id) => !fine.has(id));
    if (unfinished.length === 0) return mismatched;
    const claims = (await this.leafModel
      .find({ anchorId: { $in: unfinished } })
      .sort({ _id: 1 })
      .limit(20)
      .select({ _id: 1, anchorId: 1 })
      .lean()
      .exec()) as Array<{ _id: string; anchorId: string }>;
    return [
      ...mismatched,
      ...claims.map(
        (claim) =>
          `${claim._id} (claimed by unfinished anchor ${claim.anchorId})`,
      ),
    ];
  }

  /**
   * Versions older than the newest cutoff that no BUILT anchor holds: never
   * claimed, or claimed by an anchor that was never finished.
   */
  private async coverage(now: Date): Promise<Check> {
    const unfinished = await this.unfinishedClaims(now);
    const newest = await this.anchorModel
      .findOne({ status: 'built' })
      .sort({ _id: -1 })
      .select({ cutoff: 1 })
      .lean()
      .exec();
    if (!newest?.cutoff) {
      return unfinished.length === 0
        ? unknown('no anchor built yet')
        : fail(`not anchored: ${unfinished.join(', ')}`);
    }
    const cutoff = newest.cutoff;
    const missing: string[] = [...unfinished];
    for (const kind of ['block', 'comment'] as const) {
      const rows = await this.modelOf(kind)
        .aggregate<{ _id: Types.ObjectId }>([
          { $match: { createdAt: { $lte: cutoff } } },
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
          { $limit: 20 },
          { $project: { _id: 1 } },
        ])
        .exec();
      missing.push(...rows.map((row) => leafId(kind, row._id)));
    }
    return missing.length === 0
      ? pass(`every version up to ${cutoff.toISOString()} is anchored`)
      : fail(`not anchored: ${missing.join(', ')}`);
  }

  /**
   * The admin health view: one page of anchors, newest first, each check
   * counted on its own (totals are for that page); coverage is always over
   * every version.
   */
  async verifyAll(now = new Date(), page = 1): Promise<HealthReport> {
    const found = (await this.anchorModel
      .find({})
      .sort({ _id: -1 })
      .skip((page - 1) * ANCHORS_PAGE_SIZE)
      .limit(ANCHORS_PAGE_SIZE + 1)
      .lean()
      .exec()) as TimestampAnchor[];
    const anchors = found.slice(0, ANCHORS_PAGE_SIZE);
    const reports: AnchorReport[] = [];
    for (const anchor of anchors) {
      const report = await this.verifyAnchor(anchor);
      reports.push(report);
      // Remembered, so the global count covers pages nobody opened since.
      await this.anchorModel
        .updateOne(
          { _id: anchor._id },
          {
            $set: {
              lastCheck: {
                at: now,
                outcome: worstOf(report),
                ...(claimCountOnly(report) ? { claimCountOnly: true } : {}),
              },
            },
          },
        )
        .exec();
    }
    const totals = {} as HealthReport['totals'];
    for (const key of ['root', 'versions', 'tsa', 'ots', 'bitcoin'] as const) {
      totals[key] = { pass: 0, fail: 0, 'cannot-measure': 0 };
      for (const report of reports) totals[key][report[key].outcome] += 1;
    }
    return {
      checkedAt: now.toISOString(),
      page,
      hasMore: found.length > ANCHORS_PAGE_SIZE,
      anchors: reports,
      coverage: await this.coverage(now),
      totalsScope: 'page',
      totals,
      global: await this.globalCounts(),
    };
  }

  /**
   * Over EVERY anchor, cheaply (review M-C): how many there are, how many
   * have a provider step or the build itself unfinished, and how many failed
   * a check when last checked or were never checked.
   */
  private async globalCounts(): Promise<HealthReport['global']> {
    const count = (filter: Record<string, unknown>) =>
      this.anchorModel.countDocuments(filter as AnchorQuery).exec();
    const oldest = (await this.anchorModel
      .findOne({ 'lastCheck.at': { $exists: true } } as AnchorQuery)
      .sort({ 'lastCheck.at': 1 })
      .select({ lastCheck: 1 })
      .lean()
      .exec()) as TimestampAnchor | null;
    return {
      anchors: await count({}),
      unfinished: await count({
        $or: [
          { status: 'building' },
          { status: 'built', 'tsa.status': { $ne: 'granted' } },
          { status: 'built', 'ots.status': { $in: ['submit', 'failed'] } },
        ],
      }),
      failedWhenLastChecked: await count({ 'lastCheck.outcome': 'fail' }),
      cannotMeasureWhenLastChecked: await count({
        'lastCheck.outcome': 'cannot-measure',
      }),
      neverChecked: await count({ lastCheck: { $exists: false } }),
      // How stale the oldest stored result is (review round 3, MEDIUM-2).
      oldestCheck: oldest?.lastCheck?.at.toISOString() ?? null,
    };
  }

  /**
   * Every person on a version chain up to `upToSeq` (round 3, MEDIUM-1):
   * a later version's hash commits to every earlier one, so its hash
   * material can test a guess about any of them.
   */
  async chainPeople(
    kind: AnchoredKind,
    key: string,
    upToSeq: number,
  ): Promise<Array<string | undefined>> {
    const rows = (await this.modelOf(kind)
      .find({
        [kind === 'block' ? 'blockId' : 'commentId']: key,
        seq: { $lte: upToSeq },
      })
      .select({ authorUserId: 1, suggestedBy: 1 })
      .lean()
      .exec()) as Array<{ authorUserId?: string; suggestedBy?: string }>;
    return rows.flatMap((row) => [row.authorUserId, row.suggestedBy]);
  }

  /**
   * One version's proof for a receipt: its leaf, its path to the root, and
   * the checks a reader would run, each with its own outcome.
   */
  async proveVersion(
    kind: AnchoredKind,
    record: VersionRecord,
  ): Promise<VersionProof> {
    const claim = await this.leafModel
      .findById(leafId(kind, record._id))
      .lean()
      .exec();
    if (!claim) return { anchored: false };
    // Without its leaves: those are read once per anchor (review L1).
    const found = (await this.anchorModel
      .findById(claim.anchorId)
      .select({ leaves: 0 })
      .lean()
      .exec()) as TimestampAnchor | null;
    // Claimed by a batch still being built: honestly not anchored yet.
    if (found?.status === 'building') return { anchored: false };
    // Anything else without a root (a deleted or altered anchor) is a
    // FAILED proof, never "pending": a claim is only written for a batch.
    const anchor: TimestampAnchor = found
      ? withBytes(found)
      : { _id: claim.anchorId, status: 'built' };
    const root = anchor.merkleRoot ?? '';
    const leaf = saltedLeaf(claim.versionHash, claim.salt) ?? '';
    const checked = found ? await this.checkedAnchor(anchor) : undefined;
    const tree = checked?.tree;
    const path = tree?.pathOf(leaf) ?? [];
    const pathCheck =
      tree && anchor.status === 'built' && rootFromPath(leaf, path) === root
        ? pass('the path leads from the leaf to the anchored root')
        : fail(
            found
              ? 'the path does not lead to the anchored root'
              : 'the anchor this version was claimed by is missing',
          );
    const rehashed = recomputeHash(kind, record);
    const hash =
      rehashed === record.hash && record.hash === claim.versionHash
        ? pass('the recorded fields give the anchored hash')
        : fail('the recorded fields no longer give the anchored hash');
    return {
      anchored: true,
      anchorId: claim.anchorId,
      leaf,
      // A claim without a salt gives none (review round 3, L-2).
      ...(typeof claim.salt === 'string' ? { salt: claim.salt } : {}),
      path,
      root,
      anchor,
      checks: {
        hash,
        path: pathCheck,
        tsa: checked?.tsa ?? checkTsa(undefined, root, this.trustedRoots),
        ots: checked?.ots ?? checkOts(undefined, root).ots,
      },
    };
  }

  /**
   * One anchor's tree and proof checks, for receipts. A built anchor never
   * changes, so this is worked out once per anchor and kept, keyed by its
   * root and the exact bytes of both proofs: a replaced root or proof is
   * checked again at once. The admin health view never uses this; it
   * re-checks everything, leaves included, on every read.
   */
  private async checkedAnchor(anchor: TimestampAnchor) {
    const digest = (bytes?: Buffer) =>
      bytes ? createHash('sha256').update(bytes).digest('hex') : '-';
    const key = [
      anchor._id,
      anchor.status,
      anchor.merkleRoot,
      digest(anchor.tsa?.response),
      digest(anchor.ots?.proof),
    ].join('|');
    const kept = this.anchorChecks.get(key);
    if (kept) return kept;
    const stored = (await this.anchorModel
      .findById(anchor._id)
      .select({ leaves: 1 })
      .lean()
      .exec()) as { leaves?: AnchoredLeaf[] } | null;
    const root = anchor.merkleRoot ?? '';
    const leaves = stored?.leaves ?? [];
    const checked = {
      tree: safeTree(leaves),
      tsa: checkTsa(anchor.tsa?.response, root, this.trustedRoots),
      ots: checkOts(anchor.ots?.proof, root).ots,
      size: Math.max(1, leaves.length),
    };
    // Oldest first out, until this one fits; one too big alone is not kept.
    for (const [oldKey, old] of this.anchorChecks) {
      if (this.cachedLeaves + checked.size <= this.anchorCacheLeaves) break;
      this.anchorChecks.delete(oldKey);
      this.cachedLeaves -= old.size;
    }
    if (this.cachedLeaves + checked.size <= this.anchorCacheLeaves) {
      this.anchorChecks.set(key, checked);
      this.cachedLeaves += checked.size;
    }
    return checked;
  }
}
