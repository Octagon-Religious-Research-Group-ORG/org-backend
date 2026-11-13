import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * - `page-submitted`: a new member page is waiting for approval (plan §2d:
 *   replaces "message Tripp when you're done");
 * - `eam-request`: a member pressed "Request EaM" (plan §2d item 9);
 * - `report`: a comment or member page has open reports (Chunk 13). One
 *   entry per target; a new report re-opens and moves it up.
 */
export const INBOX_KINDS = ['page-submitted', 'eam-request', 'report'] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const INBOX_STATUSES = ['open', 'handled'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

/** A member's optional note with an EaM request. */
export const MAX_INBOX_NOTE_LENGTH = 1_000;

/**
 * Something the admins should know about (Chunk 12), shown in the admin
 * dashboard's inbox until an admin marks it handled.
 *
 * Generic on purpose: Chunk 14 sends emails FROM this store (the `emailedAt`
 * field is reserved for it), so a new kind of notice is a new `kind`, not a
 * new collection.
 *
 * `dedupeKey` (unique while set) keeps one entry per subject: one
 * `page-submitted` per page, and one EaM request per member until an admin
 * resets it, which unsets the key.
 */
@Schema({
  collection: 'admininbox',
  timestamps: true,
  autoIndex: false,
  autoCreate: false,
})
export class AdminInboxEntry {
  @Prop({ type: String, enum: INBOX_KINDS, required: true })
  kind: InboxKind;

  @Prop({ type: String, enum: INBOX_STATUSES, required: true, default: 'open' })
  status: InboxStatus;

  /**
   * Clerk user id of the member the entry is about. For a report: the
   * reported content's author, or `imported:<commentId>` for an imported
   * comment linked to no one.
   */
  @Prop({ type: String, required: true })
  subjectUserId: string;

  /** What a `report` entry is about (Chunk 13). */
  @Prop({ type: String })
  targetType?: string;

  @Prop({ type: String })
  targetId?: string;

  /** Their member page, when the entry is about one. */
  @Prop({ type: Types.ObjectId })
  profileId?: Types.ObjectId;

  /** What the member wrote, cleaned. */
  @Prop({ type: String, maxlength: MAX_INBOX_NOTE_LENGTH })
  note?: string;

  @Prop({ type: String })
  dedupeKey?: string;

  /** Server time an admin marked it handled. */
  @Prop({ type: Date })
  handledAt?: Date;

  /** Clerk user id of that admin, or `system:<process>`. */
  @Prop({ type: String })
  handledBy?: string;

  /** Reserved for Chunk 14: when the admins were emailed about it. */
  @Prop({ type: Date })
  emailedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export type AdminInboxEntryDocument = HydratedDocument<AdminInboxEntry>;
export const AdminInboxEntrySchema =
  SchemaFactory.createForClass(AdminInboxEntry);

// The inbox, newest first, by status.
AdminInboxEntrySchema.index({ status: 1, createdAt: -1 });
// One open notice per subject (see `dedupeKey`).
AdminInboxEntrySchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);

/** The `dedupeKey` of a member's EaM request. */
export function eamKey(userId: string) {
  return `eam:${userId}`;
}

/** The `dedupeKey` of a target's "has open reports" notice (Chunk 13). */
export function reportKey(targetType: string, targetId: string) {
  return `report:${targetType}:${targetId}`;
}

/** The `dedupeKey` of a page's "waiting for approval" notice. */
export function pageSubmittedKey(profileId: Types.ObjectId | string) {
  return `page-submitted:${String(profileId)}`;
}
