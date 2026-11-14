import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * How many reports one member sent on one day (UTC), so the daily cap holds
 * however many reports arrive at once (Chunk 13 review M-1). Counts only; it
 * says nothing about what was reported.
 *
 * The row's `_id` is `<reporterUserId>|<day>` (review F1): the always-present
 * `_id` index makes it one row per reporter per day, so the cap holds even on
 * a database where `db:indexes` has not run yet.
 *
 * Each row expires on its own (TTL on `expiresAt`, two days after its day),
 * so the collection never grows past one row per active reporter per day.
 * Until the TTL index exists, old rows simply stay; nothing depends on it.
 */
@Schema({
  collection: 'reportquota',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class ReportQuota {
  /** `<reporterUserId>|<day>`, see {@link reportQuotaId}. */
  @Prop({ type: String, required: true })
  _id: string;

  /** Clerk user id. */
  @Prop({ type: String, required: true })
  reporterUserId: string;

  /** The UTC day, `YYYY-MM-DD`. */
  @Prop({ type: String, required: true })
  day: string;

  @Prop({ type: Number, required: true, min: 0 })
  n: number;

  @Prop({ type: Date, required: true })
  expiresAt: Date;
}

/** The one row of a reporter's day. */
export function reportQuotaId(reporterUserId: string, day: string) {
  return `${reporterUserId}|${day}`;
}

export type ReportQuotaDocument = HydratedDocument<ReportQuota>;
export const ReportQuotaSchema = SchemaFactory.createForClass(ReportQuota);

// Old counters delete themselves. (One row per reporter per day is the
// `_id` index's job, review F1: no other unique index is needed.)
ReportQuotaSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
