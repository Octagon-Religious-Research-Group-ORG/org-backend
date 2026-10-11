import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { makeAppendOnly } from '../../social/append-only';

/**
 * Who did what to whom, and why: role changes now, moderation decisions
 * later (plan §5). **Append-only** — an entry is never changed or removed.
 */
@Schema({ collection: 'moderationlog', autoIndex: false, versionKey: false })
export class ModerationLogEntry {
  /** Clerk user id, or `system:<process>` for automated actions. */
  @Prop({ type: String, required: true, immutable: true })
  actorUserId: string;

  /** Dotted verb, e.g. `role.change.requested`. */
  @Prop({ type: String, required: true, immutable: true })
  action: string;

  @Prop({ type: String, required: true, immutable: true })
  targetType: string;

  @Prop({ type: String, required: true, immutable: true })
  targetId: string;

  @Prop({ type: String, required: true, maxlength: 500, immutable: true })
  reason: string;

  @Prop({ type: MongooseSchema.Types.Mixed, immutable: true })
  details?: Record<string, unknown>;

  /** Server time. */
  @Prop({ type: Date, required: true, immutable: true })
  at: Date;
}

export type ModerationLogEntryDocument = HydratedDocument<ModerationLogEntry>;
export const ModerationLogEntrySchema =
  SchemaFactory.createForClass(ModerationLogEntry);

ModerationLogEntrySchema.index({ at: -1 });
ModerationLogEntrySchema.index({ targetType: 1, targetId: 1, at: -1 });

makeAppendOnly(ModerationLogEntrySchema, 'moderationlog');
