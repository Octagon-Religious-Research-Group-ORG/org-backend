import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, type Types } from 'mongoose';
import {
  BeliefTab,
  type BeliefTabDocument,
} from '../../social/schemas/belief-tab.schema';
import {
  BeliefVote,
  type BeliefVoteDocument,
  type VoteValue,
  type VoterTier,
} from '../../social/schemas/belief-vote.schema';
import {
  BlockVersion,
  type BlockVersionDocument,
} from '../../social/schemas/block-version.schema';
import {
  ProfileBlock,
  type ProfileBlockDocument,
} from '../../social/schemas/profile-block.schema';
import {
  VoteTally,
  type VoteTallyDocument,
} from '../../social/schemas/vote-tally.schema';
import { describeFailure } from '../comments/comment-limits';
import { TEXT_TURN_STALE_MS } from '../tab-text-turns';
import { readBeliefTexts } from './belief-texts';

/** A writer's mark this old is recounted by the next list read. */
export const TALLY_REPAIR_AFTER_MS = 30_000;
/**
 * A writer's mark this old belongs to a writer that died: the same limit as
 * the text turns and vote claims a writer holds while it writes.
 */
export const WRITER_MARK_STALE_MS = TEXT_TURN_STALE_MS;
/** At most this many left-behind tallies repaired per list read. */
export const TALLY_REPAIRS_PER_READ = 10;

/** The counted fields of a tally, as stored. */
export interface TallyRow {
  tabId: string;
  profileId: Types.ObjectId;
  rev: number;
  /** Writers in flight (see the schema); absent or empty when none. */
  writers?: Array<{ id: string; at: Date }>;
  live?: boolean;
  textSeq?: number;
  agreeMember?: number;
  agreeAnon?: number;
  disagreeMember?: number;
  disagreeAnon?: number;
  earlierMember?: number;
  earlierAnon?: number;
  agreeAll?: number;
  tabCreatedAt?: Date;
}

/** What a reader is shown for one belief. */
export interface ShownCounts {
  agree: number;
  disagree: number;
  /** Votes kept from an earlier wording; not counted. */
  earlierWording: number;
}

export const TALLY_FIELDS = {
  tabId: 1,
  profileId: 1,
  rev: 1,
  writers: 1,
  live: 1,
  textSeq: 1,
  agreeMember: 1,
  agreeAnon: 1,
  disagreeMember: 1,
  disagreeAnon: 1,
  earlierMember: 1,
  earlierAnon: 1,
  agreeAll: 1,
  tabCreatedAt: 1,
};

/**
 * The counts a reader sees: the current wording only, and anonymous votes
 * only while the admin setting lets them count.
 */
export function shownCounts(
  row: TallyRow | undefined,
  anonymousCount: boolean,
): ShownCounts {
  const anon = (value: number | undefined) =>
    anonymousCount ? (value ?? 0) : 0;
  return {
    agree: (row?.agreeMember ?? 0) + anon(row?.agreeAnon),
    disagree: (row?.disagreeMember ?? 0) + anon(row?.disagreeAnon),
    earlierWording: (row?.earlierMember ?? 0) + anon(row?.earlierAnon),
  };
}

/** The tally field the Beliefs page sorts and filters by. */
export function agreeField(anonymousCount: boolean) {
  return anonymousCount ? ('agreeAll' as const) : ('agreeMember' as const);
}

interface VoteRow {
  value: VoteValue;
  textSeq: number;
  voterTier: VoterTier;
}

/**
 * Keeps `votetallies` exact (Chunk 10); see the schema for the rule. Every
 * writer that changes what a belief's tally counts (a vote, a text edit, an
 * accepted suggestion, a removal) calls {@link touch} before its write, which
 * returns the writer's own mark, and {@link settle} with that mark after it.
 *
 * Only the writer that set a mark removes it (or the repair, once the mark
 * is older than any live writer can be). A reader may recount at any time,
 * but never clears a mark: its count may predate a write still in flight
 * (fix round 1, MEDIUM 1).
 *
 * TODO(Chunks 12/17): a voter who later loses the right to vote (page
 * removed, made pending or deleted, or an admin action) keeps their votes
 * counted. Nothing recounts on those events yet; whether such votes should
 * stop counting is a decision for the moderation and deletion chunks.
 */
@Injectable()
export class VoteTalliesService {
  private readonly logger = new Logger(VoteTalliesService.name);

  constructor(
    @InjectModel(VoteTally.name)
    private readonly tallyModel: Model<VoteTallyDocument>,
    @InjectModel(BeliefVote.name)
    private readonly voteModel: Model<BeliefVoteDocument>,
    @InjectModel(BeliefTab.name)
    private readonly tabModel: Model<BeliefTabDocument>,
    @InjectModel(ProfileBlock.name)
    private readonly blockModel: Model<ProfileBlockDocument>,
    @InjectModel(BlockVersion.name)
    private readonly versionModel: Model<BlockVersionDocument>,
  ) {}

  /**
   * Marks a belief's tally as possibly behind, before a write, with a mark
   * of this writer's own. A failure here fails the write before it changes
   * anything.
   *
   * @returns the mark, to pass to {@link settle}
   */
  async touch(tabId: string, profileId: Types.ObjectId): Promise<string> {
    const id = randomUUID();
    const bump = () =>
      this.tallyModel
        .updateOne(
          { tabId },
          {
            $inc: { rev: 1 },
            $set: { profileId },
            $push: { writers: { id, at: new Date() } },
          },
          { upsert: true },
        )
        .exec();
    try {
      await bump();
    } catch (error) {
      // Two first touches of one belief race to insert; the loser bumps.
      if ((error as { code?: unknown }).code !== 11000) throw error;
      await bump();
    }
    return id;
  }

  /**
   * After a write: removes this writer's mark, bumps the revision and
   * recounts. Never fails the write it follows: a failure leaves the mark,
   * so reads keep recounting until the repair drops it.
   *
   * @param mark - what {@link touch} returned; undefined when the touch
   *   itself failed (then there is only the recount to do)
   */
  async settle(tabId: string, mark: string | undefined) {
    try {
      await this.tallyModel
        .updateOne(
          { tabId },
          mark === undefined
            ? { $inc: { rev: 1 } }
            : { $inc: { rev: 1 }, $pull: { writers: { id: mark } } },
        )
        .exec();
      await this.recompute(tabId);
    } catch (error) {
      this.logger.warn(
        `Could not recount the votes of ${tabId}; a read will: ${describeFailure(error)}`,
      );
    }
  }

  /**
   * Counts a belief's votes again from `beliefvotes`, and saves the counts
   * only if no writer bumped the revision meanwhile. Writers' marks are left
   * as they are: a reader's count may predate a write still in flight.
   */
  async recompute(tabId: string) {
    const tally = (await this.tallyModel
      .findOne({ tabId })
      .select({ rev: 1 })
      .lean()
      .exec()) as { rev: number } | null;
    if (!tally) return;
    const tab = (await this.tabModel
      .findOne({ tabId })
      .select({ profileId: 1, removedAt: 1, createdAt: 1 })
      .lean()
      .exec()) as {
      profileId: Types.ObjectId;
      removedAt?: Date;
      createdAt?: Date;
    } | null;
    const textSeq = tab
      ? (
          await readBeliefTexts(this.blockModel, this.versionModel, [
            { profileId: tab.profileId, tabId },
          ])
        ).get(tabId)?.textSeq
      : undefined;
    const votes = (await this.voteModel
      .find({ tabId, value: { $exists: true } })
      .select({ value: 1, textSeq: 1, voterTier: 1 })
      .lean()
      .exec()) as unknown as VoteRow[];

    const count = (test: (vote: VoteRow) => boolean, tier: VoterTier) =>
      votes.filter((vote) => vote.voterTier === tier && test(vote)).length;
    const current = (value: VoteValue) => (vote: VoteRow) =>
      vote.textSeq === textSeq && vote.value === value;
    const earlier = (vote: VoteRow) => vote.textSeq !== textSeq;
    const agreeMember = count(current('agree'), 'member');
    const agreeAnon = count(current('agree'), 'anonymous');

    await this.tallyModel
      .updateOne(
        { tabId, rev: tally.rev },
        {
          $set: {
            live: Boolean(tab) && !tab?.removedAt,
            textSeq: textSeq ?? 0,
            agreeMember,
            agreeAnon,
            disagreeMember: count(current('disagree'), 'member'),
            disagreeAnon: count(current('disagree'), 'anonymous'),
            earlierMember: count(earlier, 'member'),
            earlierAnon: count(earlier, 'anonymous'),
            agreeAll: agreeMember + agreeAnon,
            tabCreatedAt: tab?.createdAt ?? new Date(0),
          },
        },
      )
      .exec();
  }

  /**
   * The tallies of a page's beliefs as they stand now. A tally with a writer
   * in flight, never counted, or counted for another wording than the page
   * shows is recounted first, so a page never shows counts a dead writer
   * left behind.
   *
   * @param tabs - the page's live beliefs, each with the text version shown
   */
  async forPage(
    profileId: Types.ObjectId,
    tabs: ReadonlyArray<{ tabId: string; textSeq: number }>,
  ): Promise<Map<string, TallyRow>> {
    const read = async () =>
      new Map(
        (
          (await this.tallyModel
            .find({ profileId })
            .select(TALLY_FIELDS)
            .lean()
            .exec()) as unknown as TallyRow[]
        ).map((row) => [row.tabId, row]),
      );
    const rows = await read();
    const behind = tabs.filter(({ tabId, textSeq }) => {
      const row = rows.get(tabId);
      return row !== undefined && (isBehind(row) || row.textSeq !== textSeq);
    });
    if (behind.length === 0) return rows;
    for (const { tabId } of behind) await this.recompute(tabId);
    return read();
  }

  /**
   * Recounts tallies whose writer has not settled for a while, a few per
   * call, and drops marks older than any live writer can be: their writer
   * died, and this recount is the one it never ran.
   */
  async repairLeftBehind() {
    const now = Date.now();
    const rows = (await this.tallyModel
      .find({
        'writers.at': {
          $exists: true,
          $lt: new Date(now - TALLY_REPAIR_AFTER_MS),
        },
      })
      .limit(TALLY_REPAIRS_PER_READ)
      .select({ tabId: 1 })
      .lean()
      .exec()) as Array<{ tabId: string }>;
    const dead = new Date(now - WRITER_MARK_STALE_MS);
    for (const row of rows) {
      await this.tallyModel
        .updateOne(
          { tabId: row.tabId, 'writers.at': { $lt: dead } },
          { $inc: { rev: 1 }, $pull: { writers: { at: { $lt: dead } } } },
        )
        .exec();
      await this.recompute(row.tabId);
    }
  }
}

/** A writer in flight, or never counted. */
export function isBehind(row: TallyRow): boolean {
  return (row.writers?.length ?? 0) > 0 || row.live === undefined;
}
