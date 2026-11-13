import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
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
import { readBeliefTexts } from './belief-texts';

/** A tally left dirty this long by a writer is repaired by the next list read. */
export const TALLY_REPAIR_AFTER_MS = 30_000;
/** At most this many left-behind tallies repaired per list read. */
export const TALLY_REPAIRS_PER_READ = 10;

/** The counted fields of a tally, as stored. */
export interface TallyRow {
  tabId: string;
  profileId: Types.ObjectId;
  rev: number;
  dirtySince?: Date;
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
  dirtySince: 1,
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
 * Keeps `votetallies` exact (Chunk 10); see the schema for the revision
 * rule. Every writer that changes what a belief's tally counts (a vote, a
 * text edit, an accepted suggestion, a removal) calls {@link touch} before
 * its write and {@link settle} after it.
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
   * Marks a belief's tally as possibly behind, before a write. A failure
   * here fails the write before it changes anything.
   */
  async touch(tabId: string, profileId: Types.ObjectId) {
    const bump = () =>
      this.tallyModel
        .updateOne(
          { tabId },
          { $inc: { rev: 1 }, $set: { dirtySince: new Date(), profileId } },
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
  }

  /**
   * After a write: bumps the revision again and recounts. Never fails the
   * write it follows: a failure leaves the tally dirty, and reads repair it.
   */
  async settle(tabId: string, profileId: Types.ObjectId) {
    try {
      await this.touch(tabId, profileId);
      await this.recompute(tabId);
    } catch (error) {
      this.logger.warn(
        `Could not recount the votes of ${tabId}; a read will: ${describeFailure(error)}`,
      );
    }
  }

  /**
   * Counts a belief's votes again from `beliefvotes`, and saves the counts
   * only if no writer bumped the revision meanwhile.
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
          $unset: { dirtySince: 1 },
        },
      )
      .exec();
  }

  /**
   * The tallies of a page's beliefs as they stand now. A tally that is dirty
   * or counted for another wording than the page shows is recounted first,
   * so a page never shows counts a dead writer left behind.
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

  /** Recounts tallies a writer left behind, oldest first, a few per call. */
  async repairLeftBehind() {
    const cutoff = new Date(Date.now() - TALLY_REPAIR_AFTER_MS);
    const rows = await this.tallyModel
      .find({ dirtySince: { $exists: true, $lt: cutoff } })
      .sort({ dirtySince: 1 })
      .limit(TALLY_REPAIRS_PER_READ)
      .select({ tabId: 1 })
      .lean()
      .exec();
    for (const row of rows) await this.recompute(row.tabId);
  }
}

/** Dirty, or never counted. */
export function isBehind(row: TallyRow): boolean {
  return row.dirtySince !== undefined || row.live === undefined;
}
