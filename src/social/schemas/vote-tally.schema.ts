import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * The counted votes of one belief (Chunk 10), recomputed from `beliefvotes`
 * whenever a vote, the belief's text or its removal changes. A cache: the
 * votes are the record, and a tally can always be recomputed.
 *
 * Kept exact under races by a revision number: every writer bumps `rev`
 * (and sets `dirtySince`) BEFORE and AFTER its write, and a recompute saves
 * only if `rev` is still the one it read before counting. A recompute that
 * lost a race therefore saves nothing, and the writer's own recompute, run
 * after its last bump, saves the right answer. A writer that died leaves
 * `dirtySince` set, and reads recompute it (`VoteTalliesService.repair*`).
 *
 * Both voter tiers are counted separately, so turning the admin setting
 * `anonymousMayVote` on or off changes what is shown at once, with nothing
 * to recount.
 */
@Schema({
  collection: 'votetallies',
  timestamps: true,
  autoIndex: false,
  autoCreate: false,
})
export class VoteTally {
  @Prop({ type: String, required: true })
  tabId: string;

  @Prop({ type: Types.ObjectId, required: true })
  profileId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0, default: 0 })
  rev: number;

  /** Set while a write may have left the counts behind. */
  @Prop({ type: Date })
  dirtySince?: Date;

  /** The belief is on its page (not removed). Absent until first counted. */
  @Prop({ type: Boolean })
  live?: boolean;

  /** The belief text's version the counts are for. */
  @Prop({ type: Number, min: 0 })
  textSeq?: number;

  @Prop({ type: Number, min: 0 }) agreeMember?: number;
  @Prop({ type: Number, min: 0 }) agreeAnon?: number;
  @Prop({ type: Number, min: 0 }) disagreeMember?: number;
  @Prop({ type: Number, min: 0 }) disagreeAnon?: number;
  /** Votes kept from an earlier wording, not counted. */
  @Prop({ type: Number, min: 0 }) earlierMember?: number;
  @Prop({ type: Number, min: 0 }) earlierAnon?: number;
  /** agreeMember + agreeAnon: the sort key while anonymous votes count. */
  @Prop({ type: Number, min: 0 }) agreeAll?: number;

  /** When the belief was added: the tie-break, newest first. */
  @Prop({ type: Date })
  tabCreatedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export type VoteTallyDocument = HydratedDocument<VoteTally>;
export const VoteTallySchema = SchemaFactory.createForClass(VoteTally);

VoteTallySchema.index({ tabId: 1 }, { unique: true });
VoteTallySchema.index({ profileId: 1 });
// The Beliefs page list, one index per counting rule: most agrees first,
// then newest, then the id as the cursor's last tie-break.
VoteTallySchema.index({ live: 1, agreeMember: -1, tabCreatedAt: -1, tabId: 1 });
VoteTallySchema.index({ live: 1, agreeAll: -1, tabCreatedAt: -1, tabId: 1 });
// Tallies a writer may have left behind.
VoteTallySchema.index(
  { dirtySince: 1 },
  { partialFilterExpression: { dirtySince: { $exists: true } } },
);
