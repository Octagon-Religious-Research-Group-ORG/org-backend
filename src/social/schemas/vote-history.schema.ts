import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { makeAppendOnly } from '../append-only';
import {
  VOTE_VALUES,
  VOTER_TIERS,
  type VoteValue,
  type VoterTier,
} from './belief-vote.schema';

/**
 * - `cast`: a first vote, or one after a withdrawal;
 * - `change`: agree to disagree or back;
 * - `confirm`: the same vote on a newer wording (or a refreshed tier);
 * - `withdraw`: the vote taken back.
 */
export const VOTE_ACTIONS = ['cast', 'change', 'confirm', 'withdraw'] as const;
export type VoteAction = (typeof VOTE_ACTIONS)[number];

/**
 * Every vote a member casts, changes, confirms or withdraws (Chunk 10).
 * **Append-only** and hash-chained like `commentversions` (plan D8), one
 * chain per voter and belief (`voteKey`), under `VOTE_HASH_SCHEME`. The
 * unique (voteKey, seq) index makes two concurrent writes unable to fork it.
 * The daily anchor (plan §6) selects a day's rows by `createdAt`.
 */
@Schema({
  collection: 'votehistory',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class VoteHistoryEntry {
  /** `<tabId>:<voterUserId>`; the chain's key. */
  @Prop({ type: String, required: true, immutable: true })
  voteKey: string;

  @Prop({ type: Number, required: true, min: 1, immutable: true })
  seq: number;

  @Prop({ type: String, required: true, immutable: true })
  tabId: string;

  @Prop({ type: String, required: true, immutable: true })
  voterUserId: string;

  @Prop({ type: String, enum: VOTE_ACTIONS, required: true, immutable: true })
  action: VoteAction;

  /** Absent for a withdrawal. */
  @Prop({ type: String, enum: VOTE_VALUES, immutable: true })
  value?: VoteValue;

  @Prop({ type: Number, required: true, min: 0, immutable: true })
  textSeq: number;

  @Prop({ type: String, enum: VOTER_TIERS, required: true, immutable: true })
  voterTier: VoterTier;

  /** Server time; part of the hash. */
  @Prop({ type: Date, required: true, immutable: true })
  createdAt: Date;

  @Prop({
    type: String,
    required: true,
    match: /^[0-9a-f]{64}$/,
    immutable: true,
  })
  prevHash: string;

  @Prop({
    type: String,
    required: true,
    match: /^[0-9a-f]{64}$/,
    immutable: true,
  })
  hash: string;
}

export type VoteHistoryEntryDocument = HydratedDocument<VoteHistoryEntry>;
export const VoteHistoryEntrySchema =
  SchemaFactory.createForClass(VoteHistoryEntry);

VoteHistoryEntrySchema.index({ voteKey: 1, seq: 1 }, { unique: true });
VoteHistoryEntrySchema.index({ createdAt: 1 });

makeAppendOnly(VoteHistoryEntrySchema, 'votehistory');
