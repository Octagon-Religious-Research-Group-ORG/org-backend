import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { makeAppendOnly } from '../../social/append-only';
import { VISIT_PURGE } from '../../social/purge-rules';

export const VISIT_KINDS = ['guest-entry'] as const;
export type VisitKind = (typeof VISIT_KINDS)[number];

/**
 * A visitor entering the Members Community without an account (owner, D10:
 * "track visitors' nicknames and IP addresses"). **Append-only.** Disclosed on
 * the entry page and in the membership terms.
 */
@Schema({
  collection: 'visitrecords',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class VisitRecord {
  @Prop({ type: String, enum: VISIT_KINDS, required: true })
  kind: VisitKind;

  @Prop({ type: Date, required: true })
  at: Date;

  @Prop({ type: String, maxlength: 64 })
  ip?: string;

  /**
   * Set by the five-year purge (Chunk 17, `purge-rules.ts`) when this row's
   * personal fields were removed; the row itself stays.
   */
  @Prop({ type: Date })
  purgedAt?: Date;
}

export type VisitRecordDocument = HydratedDocument<VisitRecord>;
export const VisitRecordSchema = SchemaFactory.createForClass(VisitRecord);
makeAppendOnly(VisitRecordSchema, 'visitrecords', undefined, VISIT_PURGE);

VisitRecordSchema.index({ at: -1 });
