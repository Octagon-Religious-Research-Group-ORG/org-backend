import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const VOTE_VALUES = ['agree', 'disagree'] as const;
export type VoteValue = (typeof VOTE_VALUES)[number];

/**
 * - `member`: the voter's page is under their own name;
 * - `anonymous`: under a nickname. Counted only while the admin setting
 *   `anonymousMayVote` is on (plan §2b item 5); kept either way.
 */
export const VOTER_TIERS = ['member', 'anonymous'] as const;
export type VoterTier = (typeof VOTER_TIERS)[number];

/** A vote being written: claimed on the row, then recorded, then confirmed. */
@Schema({ _id: false, versionKey: false })
export class PendingVote {
  /** The history `seq` this write will record. */
  @Prop({ type: Number, required: true, min: 1 })
  seq: number;

  /** Absent for a withdrawal. */
  @Prop({ type: String, enum: VOTE_VALUES })
  value?: VoteValue;

  @Prop({ type: Number, required: true, min: 0 })
  textSeq: number;

  @Prop({ type: String, enum: VOTER_TIERS, required: true })
  voterTier: VoterTier;

  @Prop({ type: Date, required: true })
  at: Date;
}
export const PendingVoteSchema = SchemaFactory.createForClass(PendingVote);

/**
 * One voter's current vote on one belief (Chunk 10): at most one row per
 * (belief, voter), by the unique index, so a double click or two windows can
 * never make two votes.
 *
 * The row is DERIVED from the voter's append-only, hash-chained history
 * (`votehistory`), written like a Chunk 9 comment: the row is claimed
 * (`pending`), the history entry is appended, then the row is confirmed
 * (`historySeq`). Only confirmed fields are ever counted. A write that
 * stops part-way is finished or undone by the voter's next write
 * (`VotesService.repair`).
 *
 * `textSeq` is the belief text's version the vote was cast on: only votes on
 * the CURRENT wording count. A removed belief keeps its votes.
 */
@Schema({
  collection: 'beliefvotes',
  timestamps: true,
  autoIndex: false,
  autoCreate: false,
})
export class BeliefVote {
  @Prop({ type: Types.ObjectId, required: true })
  profileId: Types.ObjectId;

  @Prop({ type: String, required: true })
  tabId: string;

  /** Clerk user id; never sent to a client. */
  @Prop({ type: String, required: true })
  voterUserId: string;

  /** Absent while there is no vote (never cast, or withdrawn). */
  @Prop({ type: String, enum: VOTE_VALUES })
  value?: VoteValue;

  @Prop({ type: Number, min: 0 })
  textSeq?: number;

  @Prop({ type: String, enum: VOTER_TIERS })
  voterTier?: VoterTier;

  /** When the confirmed state was written. */
  @Prop({ type: Date })
  castAt?: Date;

  /** The newest history entry this row shows; 0 before the first. */
  @Prop({ type: Number, required: true, min: 0, default: 0 })
  historySeq: number;

  @Prop({ type: PendingVoteSchema })
  pending?: PendingVote;

  createdAt?: Date;
  updatedAt?: Date;
}

export type BeliefVoteDocument = HydratedDocument<BeliefVote>;
export const BeliefVoteSchema = SchemaFactory.createForClass(BeliefVote);

// One vote per voter per belief; also serves the tally's per-belief read.
BeliefVoteSchema.index({ tabId: 1, voterUserId: 1 }, { unique: true });
// A voter's own votes on one page, and their unfinished writes.
BeliefVoteSchema.index({ voterUserId: 1, profileId: 1 });
