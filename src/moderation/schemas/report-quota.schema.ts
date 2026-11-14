import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * How many reports one member sent on one day (UTC), so the daily cap holds
 * however many reports arrive at once (Chunk 13 review M-1): a report takes
 * a slot with one conditional upsert, and the unique key refuses the slot
 * past the cap. Counts only; it says nothing about what was reported.
 *
 * Each row expires on its own (TTL on `expiresAt`, two days after its day),
 * so the collection never grows past one row per active reporter per day.
 */
@Schema({
  collection: 'reportquota',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class ReportQuota {
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

export type ReportQuotaDocument = HydratedDocument<ReportQuota>;
export const ReportQuotaSchema = SchemaFactory.createForClass(ReportQuota);

// One counter per reporter per day: what makes the cap atomic.
ReportQuotaSchema.index({ reporterUserId: 1, day: 1 }, { unique: true });
// Old counters delete themselves.
ReportQuotaSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
