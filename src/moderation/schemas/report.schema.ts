import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * What a member can report (Chunk 13):
 * - `comment`: any listed comment, on a belief, a page's own thread or one of
 *   ORG's own pages (Chunk 10b); `targetId` is its `commentId`;
 * - `member-page`: a member page; `targetId` is the page's `_id`.
 */
export const REPORT_TARGET_TYPES = ['comment', 'member-page'] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

/** The short reasons a reporter picks from. */
export const REPORT_REASONS = [
  'harassment',
  'hate',
  'spam',
  'personal-information',
  'illegal',
  'off-topic',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATUSES = ['open', 'resolved'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/**
 * How a report was closed. Every action on a target closes ALL of its open
 * reports with the same resolution:
 * - `hidden` / `removed` / `restored`: what the moderator did to a comment;
 * - `dismissed`: nothing to do;
 * - `member-removed`: the page was removed from the Members section
 *   (Chunk 12), which closes the page's reports in the same transaction.
 */
export const REPORT_RESOLUTIONS = [
  'hidden',
  'removed',
  'restored',
  'dismissed',
  'member-removed',
] as const;
export type ReportResolution = (typeof REPORT_RESOLUTIONS)[number];

/** The optional note a reporter may add. */
export const MAX_REPORT_NOTE_LENGTH = 1_000;

/**
 * One member's report about one comment or member page (plan §5 `reports`).
 *
 * - Only admins ever read a report: not its existence, its count or who
 *   wrote it reaches anyone else, and the reported member is never told.
 * - One OPEN report per reporter per target (a partial unique index);
 *   once closed the same member may report the target again.
 * - `targetProfileId` is the page the target sits on: a member page, or the
 *   website page of an ORG page thread (Chunk 10b TODO), so it is not always
 *   a `socialprofiles` id.
 */
@Schema({
  collection: 'reports',
  timestamps: true,
  autoIndex: false,
  autoCreate: false,
})
export class Report {
  @Prop({ type: String, enum: REPORT_TARGET_TYPES, required: true })
  targetType: ReportTargetType;

  @Prop({ type: String, required: true })
  targetId: string;

  @Prop({ type: Types.ObjectId, required: true })
  targetProfileId: Types.ObjectId;

  /** Clerk user id of the reporter. Admins only. */
  @Prop({ type: String, required: true })
  reporterUserId: string;

  @Prop({ type: String, enum: REPORT_REASONS, required: true })
  reason: ReportReason;

  @Prop({ type: String, maxlength: MAX_REPORT_NOTE_LENGTH })
  note?: string;

  @Prop({
    type: String,
    enum: REPORT_STATUSES,
    required: true,
    default: 'open',
  })
  status: ReportStatus;

  @Prop({ type: String, enum: REPORT_RESOLUTIONS })
  resolution?: ReportResolution;

  /** The admin who closed it (Clerk user id), and when (server time). */
  @Prop({ type: String })
  resolvedBy?: string;

  @Prop({ type: Date })
  resolvedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export type ReportDocument = HydratedDocument<Report>;
export const ReportSchema = SchemaFactory.createForClass(Report);

// One open report per reporter per target.
ReportSchema.index(
  { targetType: 1, targetId: 1, reporterUserId: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } },
);
// The queue: reports by status, grouped by target, oldest first; and closing
// one target's open reports.
ReportSchema.index({ status: 1, targetType: 1, targetId: 1, createdAt: 1 });
// The per-day cap on one member's reports.
ReportSchema.index({ reporterUserId: 1, createdAt: -1 });
