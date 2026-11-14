import { X509Certificate } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
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

const pass = (detail: string): Check => ({ outcome: 'pass', detail });
const fail = (detail: string): Check => ({ outcome: 'fail', detail });
const unknown = (detail: string): Check => ({
  outcome: 'cannot-measure',
  detail,
});

/** The tree the leaves give, or undefined when they give none. */
function safeTree(leaves: readonly AnchoredLeaf[]) {
  try {
    return buildTree(leaves.map((leaf) => leaf.versionHash));
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
      .select({ versionHash: 1 })
      .lean()
      .exec()) as Array<{ _id: string; versionHash: string }>;
    const claimed = new Map(
      claims.map((claim) => [claim._id, claim.versionHash]),
    );
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
      } else if (!record) {
        problems.push(`${id}: version missing`);
      } else if (record.hash !== leaf.versionHash) {
        problems.push(`${id}: stored hash differs from the anchored one`);
      } else if (recomputeHash(leaf.kind, record) !== record.hash) {
        problems.push(`${id}: its fields no longer give its hash`);
      }
    }
    return problems.length === 0
      ? pass(`${leaves.length} version(s) rehash to their anchored leaves`)
      : fail(problems.slice(0, 20).join('; '));
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
    if (anchor.status !== 'built') {
      const note = unknown(
        anchor.status === 'empty'
          ? 'anchor holds no version'
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

  /** Versions older than the newest cutoff that no anchor has claimed. */
  private async coverage(): Promise<Check> {
    const newest = await this.anchorModel
      .findOne({ status: 'built' })
      .sort({ _id: -1 })
      .select({ cutoff: 1 })
      .lean()
      .exec();
    if (!newest?.cutoff) return unknown('no anchor built yet');
    const cutoff = newest.cutoff;
    const missing: string[] = [];
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

  /** The admin health view: every anchor, each check counted on its own. */
  async verifyAll(now = new Date()): Promise<HealthReport> {
    const anchors = (await this.anchorModel
      .find({})
      .sort({ _id: -1 })
      .lean()
      .exec()) as TimestampAnchor[];
    const reports: AnchorReport[] = [];
    for (const anchor of anchors) reports.push(await this.verifyAnchor(anchor));
    const totals = {} as HealthReport['totals'];
    for (const key of ['root', 'versions', 'tsa', 'ots', 'bitcoin'] as const) {
      totals[key] = { pass: 0, fail: 0, 'cannot-measure': 0 };
      for (const report of reports) totals[key][report[key].outcome] += 1;
    }
    return {
      checkedAt: now.toISOString(),
      anchors: reports,
      coverage: await this.coverage(),
      totals,
    };
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
    const found = (await this.anchorModel
      .findById(claim.anchorId)
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
    const leaf = leafHash(claim.versionHash);
    const tree = safeTree(anchor.leaves ?? []);
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
      path,
      root,
      anchor,
      checks: {
        hash,
        path: pathCheck,
        tsa: checkTsa(anchor.tsa?.response, root, this.trustedRoots),
        ots: checkOts(anchor.ots?.proof, root).ots,
      },
    };
  }
}
