import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * - `sending`: a tick holds it until `leaseUntil`; past that another takes it
 *   over and sends the SAME items under the SAME idempotency key;
 * - `sent`: done for the day;
 * - `failed`: the send failed; retried while attempts remain;
 * - `deferred`: the day's email budget ran out; retried by a later tick;
 * - `nothing`: every item was dropped (settings, access), nothing sent.
 */
export const DIGEST_STATUSES = [
  'sending',
  'sent',
  'failed',
  'deferred',
  'nothing',
] as const;
export type DigestStatus = (typeof DIGEST_STATUSES)[number];

/**
 * One member's daily digest for one UTC day (Chunk 14). The unique
 * (userId, day) row is the claim: two server instances, or a tick and a
 * restart, can never both send a member's email for the same day.
 */
@Schema({
  collection: 'notificationdigests',
  timestamps: true,
  autoIndex: false,
  autoCreate: false,
})
export class NotificationDigestRow {
  @Prop({ type: String, required: true })
  userId: string;

  /** UTC day it was sent on, `YYYY-MM-DD`. */
  @Prop({ type: String, required: true })
  day: string;

  @Prop({ type: String, enum: DIGEST_STATUSES, required: true })
  status: DigestStatus;

  /** The queue rows this email is about, fixed when the row is claimed. */
  @Prop({ type: [Types.ObjectId], default: [] })
  itemIds: Types.ObjectId[];

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  attempts: number;

  @Prop({ type: Date })
  leaseUntil?: Date;

  @Prop({ type: String })
  leaseToken?: string;

  @Prop({ type: Date })
  sentAt?: Date;

  @Prop({ type: Date, required: true })
  expiresAt: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export type NotificationDigestDocument =
  HydratedDocument<NotificationDigestRow>;
export const NotificationDigestRowSchema = SchemaFactory.createForClass(
  NotificationDigestRow,
);

// The claim: one digest per member per day.
NotificationDigestRowSchema.index({ userId: 1, day: 1 }, { unique: true });
// Old rows delete themselves.
NotificationDigestRowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
