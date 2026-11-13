import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { VoteValue, VoterTier } from './schemas/belief-vote.schema';
import {
  type VoteAction,
  VoteHistoryEntry,
  type VoteHistoryEntryDocument,
} from './schemas/vote-history.schema';
import {
  type ChainVerdict,
  computeVersionHash,
  GENESIS_HASH,
  VOTE_HASH_SCHEME,
  verifyChain,
} from './version-chain';

export const VOTE_BUSY =
  'Your vote is being saved in another window. Please try again in a moment.';

/** One event in a voter's history of one belief. */
export interface VoteEvent {
  action: VoteAction;
  /** Absent for a withdrawal. */
  value?: VoteValue;
  textSeq: number;
  voterTier: VoterTier;
}

export interface AppendVoteInput extends VoteEvent {
  tabId: string;
  voterUserId: string;
  /** The newest `seq` the writer saw; the entry lands only on top of it. */
  expectedSeq: number;
}

interface StoredVoteEntry extends VoteEvent {
  voteKey: string;
  seq: number;
  voterUserId: string;
  createdAt: Date;
  prevHash: string;
  hash: string;
}

/** The chain's key for one voter and one belief. */
export function voteKey(tabId: string, voterUserId: string): string {
  return `${tabId}:${voterUserId}`;
}

/**
 * The text a vote entry's hash commits to: a JSON array, fixed by position,
 * with `null` for a withdrawal's missing value.
 */
export function voteEventText(event: VoteEvent): string {
  return JSON.stringify([
    event.action,
    event.value ?? null,
    event.textSeq,
    event.voterTier,
  ]);
}

function asChainVersion(entry: StoredVoteEntry) {
  return {
    blockId: entry.voteKey,
    seq: entry.seq,
    text: voteEventText(entry),
    authorUserId: entry.voterUserId,
    createdAt: entry.createdAt,
    prevHash: entry.prevHash,
    hash: entry.hash,
  };
}

/**
 * Writes and verifies vote history (Chunk 10). The only code that creates
 * `votehistory` rows, with the same chain rules as block and comment
 * versions (`version-chain.ts`) under `VOTE_HASH_SCHEME`.
 */
@Injectable()
export class VoteHistoryService {
  constructor(
    @InjectModel(VoteHistoryEntry.name)
    private readonly entryModel: Model<VoteHistoryEntryDocument>,
  ) {}

  /**
   * Appends one entry on top of `expectedSeq`.
   *
   * @throws ConflictException when `expectedSeq` is not the newest entry,
   *   or another write took the next `seq` first
   */
  async append(input: AppendVoteInput) {
    const key = voteKey(input.tabId, input.voterUserId);
    const head = await this.entryModel
      .findOne({ voteKey: key })
      .sort({ seq: -1 })
      .select({ seq: 1, hash: 1 })
      .lean()
      .exec();
    if ((head?.seq ?? 0) !== input.expectedSeq) {
      throw new ConflictException(VOTE_BUSY);
    }
    const event: VoteEvent = {
      action: input.action,
      ...(input.value ? { value: input.value } : {}),
      textSeq: input.textSeq,
      voterTier: input.voterTier,
    };
    const fields = {
      voteKey: key,
      seq: input.expectedSeq + 1,
      tabId: input.tabId,
      voterUserId: input.voterUserId,
      ...event,
      createdAt: new Date(),
      prevHash: head?.hash ?? GENESIS_HASH,
    };
    const hash = computeVersionHash(
      {
        blockId: key,
        seq: fields.seq,
        text: voteEventText(event),
        authorUserId: input.voterUserId,
        createdAt: fields.createdAt,
        prevHash: fields.prevHash,
      },
      VOTE_HASH_SCHEME,
    );
    try {
      await this.entryModel.create({ ...fields, hash });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 11000) {
        throw new ConflictException(VOTE_BUSY);
      }
      throw error;
    }
    return { seq: fields.seq, createdAt: fields.createdAt };
  }

  /** The newest entry, to bring a row up to its history. */
  async head(tabId: string, voterUserId: string) {
    return (await this.entryModel
      .findOne({ voteKey: voteKey(tabId, voterUserId) })
      .sort({ seq: -1 })
      .select({
        seq: 1,
        action: 1,
        value: 1,
        textSeq: 1,
        voterTier: 1,
        createdAt: 1,
      })
      .lean()
      .exec()) as (VoteEvent & { seq: number; createdAt: Date }) | null;
  }

  /** Recomputes one voter's whole chain on one belief. Read-only. */
  async verify(tabId: string, voterUserId: string): Promise<ChainVerdict> {
    const key = voteKey(tabId, voterUserId);
    const entries = (await this.entryModel
      .find({ voteKey: key })
      .sort({ seq: 1 })
      .lean()
      .exec()) as StoredVoteEntry[];
    return verifyChain(key, entries.map(asChainVersion), VOTE_HASH_SCHEME);
  }
}
