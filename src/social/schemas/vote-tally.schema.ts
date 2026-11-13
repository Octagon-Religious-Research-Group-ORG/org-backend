import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * The counted votes of one belief (Chunk 10), recomputed from `beliefvotes`
 * whenever a vote, the belief's text or its removal changes. A cache: the
 * votes are the record, and a tally can always be recomputed.
 *
 * Kept exact under races by two things:
 * - a revision number: every writer bumps `rev` BEFORE and AFTER its write,
 *   and a recompute saves only if `rev` is still the one it read before
 *   counting, so a recompute that lost a race saves nothing;
 * - one mark per writer in flight (`writers`): pushed by the writer before
 *   its write and pulled ONLY by that writer after it, before its own
 *   recount. A reader may recount (and save) while a mark is there, but
 *   never removes one, because its count may predate the write in flight.
 *   While any mark is there, every read recounts. A writer that died leaves
 *   its mark; the list read recounts it after 30 s, least recently counted
 *   first (`countedAt`), and the list read or a page read drops it once it
 *   is older than any live writer can be (`VoteTalliesService`).
 *   (Fix round 1: a single shared "dirty" date, cleared by any recount, let
 *   a reader erase a live writer's mark, so a writer that then died left
 *   wrong counts nobody would ever recount.)
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

  /** Writers in flight: each pushed and pulled by its own writer. */
  @Prop({
    type: [{ _id: false, id: { type: String }, at: { type: Date } }],
    default: undefined,
  })
  writers?: Array<{ id: string; at: Date }>;

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

  /** When the counts were last saved; the repair takes the oldest first. */
  @Prop({ type: Date })
  countedAt?: Date;

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
// Tallies a writer may have left behind, least recently counted first
// (multikey over the marks; only tallies with a mark are in it).
VoteTallySchema.index(
  { countedAt: 1, 'writers.at': 1 },
  { partialFilterExpression: { 'writers.at': { $exists: true } } },
);
