import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { makeAppendOnly } from '../../social/append-only';
import { LOG_PURGE } from '../../social/purge-rules';
import { PERSON_DETAIL_KEYS } from '../log-details';

/**
 * Who did what to whom, and why: role changes now, moderation decisions
 * later (plan §5). **Append-only** — an entry is never changed or removed.
 */
@Schema({
  collection: 'moderationlog',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
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

  /**
   * Set by the five-year purge (Chunk 17, `purge-rules.ts`) when this row's
   * personal fields were removed; the row itself stays.
   */
  @Prop({ type: Date })
  purgedAt?: Date;
}

export type ModerationLogEntryDocument = HydratedDocument<ModerationLogEntry>;
export const ModerationLogEntrySchema =
  SchemaFactory.createForClass(ModerationLogEntry);

ModerationLogEntrySchema.index({ at: -1 });
ModerationLogEntrySchema.index({ targetType: 1, targetId: 1, at: -1 });
// The account purge finds entries by actor and by target alone (round 2, #10).
ModerationLogEntrySchema.index({ actorUserId: 1 });
ModerationLogEntrySchema.index({ targetId: 1 });
// Every details key that can hold a person (round 3, L-4, M-1). Plain, not
// partial: the purge matches by plain equality (round 4, #6).
for (const key of PERSON_DETAIL_KEYS) {
  ModerationLogEntrySchema.index({ [`details.${key}`]: 1 });
}

makeAppendOnly(ModerationLogEntrySchema, 'moderationlog', undefined, LOG_PURGE);
