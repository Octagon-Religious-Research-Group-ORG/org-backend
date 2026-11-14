import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { StoredEmail, StoredEmailSchema } from './stored-email.schema';
import {
  CATEGORIES,
  type Category,
  NOTIFICATION_KINDS,
  type NotificationKind,
} from '../notification-kinds';

/** Who an admin notice goes to before it is fanned out to each admin. */
export const ADMINS_RECIPIENT = '@admins';

/**
 * - `digest`: waits for the member's daily email;
 * - `immediate`: sent as soon as possible;
 * - `fanout`: an admin notice, copied to each admin by the next tick.
 */
export const DELIVERIES = ['digest', 'immediate', 'fanout'] as const;
export type QueueDelivery = (typeof DELIVERIES)[number];

/**
 * - `queued`: waiting;
 * - `sent`: in an email Resend accepted;
 * - `skipped`: dropped (settings changed, the reader may no longer see it,
 *   no verified address, or its content was hidden);
 * - `failed`: gave up after the most attempts;
 * - `done`: an admin notice that was fanned out.
 */
export const QUEUE_STATUSES = [
  'queued',
  'sent',
  'skipped',
  'failed',
  'done',
] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

/** How long any row is kept, whatever became of it. */
export const QUEUE_KEEP_DAYS = 30;

/**
 * One thing to tell one member (Chunk 14, plan §5 `notificationqueue`).
 *
 * Holds ids only: never a member's text, never an email address. What the
 * email says and links to is worked out when it is sent, against what the
 * reader may see then.
 */
@Schema({
  collection: 'notificationqueue',
  timestamps: true,
  autoIndex: false,
  autoCreate: false,
})
export class NotificationQueueRow {
  /** Clerk user id of the reader, or {@link ADMINS_RECIPIENT}. */
  @Prop({ type: String, required: true })
  userId: string;

  @Prop({ type: String, enum: CATEGORIES, required: true })
  category: Category;

  @Prop({ type: String, enum: NOTIFICATION_KINDS, required: true })
  kind: NotificationKind;

  @Prop({ type: String, enum: DELIVERIES, required: true })
  delivery: QueueDelivery;

  @Prop({ type: String, enum: QUEUE_STATUSES, required: true })
  status: QueueStatus;

  /** Who caused it; never told about their own action. */
  @Prop({ type: String })
  actorUserId?: string;

  /** For an admin notice: the member it is about (never sent to them). */
  @Prop({ type: String })
  subjectUserId?: string;

  /** What it is about: ids only. */
  @Prop({
    type: {
      _id: false,
      profileId: { type: Types.ObjectId },
      tabId: { type: String },
      commentId: { type: String },
      claimId: { type: String },
      inboxKey: { type: String },
    },
    default: {},
  })
  refs: {
    profileId?: Types.ObjectId;
    tabId?: string;
    commentId?: string;
    claimId?: string;
    /** The admin inbox notice it is about (its `dedupeKey`). */
    inboxKey?: string;
  };

  /** One row per event per reader (unique while set). */
  @Prop({ type: String })
  dedupeKey?: string;

  /** Send attempts that failed. */
  @Prop({ type: Number, required: true, default: 0, min: 0 })
  attempts: number;

  /** Not before this time (an immediate retry, or tomorrow's budget). */
  @Prop({ type: Date })
  nextAttemptAt?: Date;

  /** A tick working on it holds it until then. */
  @Prop({ type: Date })
  leaseUntil?: Date;

  @Prop({ type: String })
  leaseToken?: string;

  /** Why it was skipped or failed, in a few words; never personal data. */
  @Prop({ type: String, maxlength: 200 })
  outcome?: string;

  @Prop({ type: Date })
  sentAt?: Date;

  /** Bumped after a definite refusal: the next send gets a new key. */
  @Prop({ type: Number, min: 0 })
  keyGen?: number;

  /**
   * When the first send under the current key STARTED (recorded before the
   * send, review N3): the 23-hour cutoff counts from it.
   */
  @Prop({ type: Date })
  keyStartedAt?: Date;

  /** The email as first sent under the current key (review L3). */
  @Prop({ type: StoredEmailSchema })
  email?: StoredEmail;

  /** The digest row it went out in. */
  @Prop({ type: Types.ObjectId })
  digestId?: Types.ObjectId;

  @Prop({ type: Date, required: true })
  expiresAt: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export type NotificationQueueDocument = HydratedDocument<NotificationQueueRow>;
export const NotificationQueueRowSchema =
  SchemaFactory.createForClass(NotificationQueueRow);

// One notice per event per reader.
NotificationQueueRowSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);
// Due work: immediates and admin fan-outs, oldest due first.
NotificationQueueRowSchema.index({ status: 1, delivery: 1, nextAttemptAt: 1 });
// One member's waiting digest items.
NotificationQueueRowSchema.index({
  userId: 1,
  status: 1,
  delivery: 1,
  createdAt: 1,
});
// Old rows delete themselves.
NotificationQueueRowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
