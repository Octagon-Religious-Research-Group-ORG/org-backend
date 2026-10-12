import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { makeAppendOnly } from '../../social/append-only';

export const VISIT_KINDS = ['guest-entry'] as const;
export type VisitKind = (typeof VISIT_KINDS)[number];

/**
 * A visitor entering the Members Community without an account (Tripp, D10:
 * "track visitors' nicknames and IP addresses"). **Append-only.** Disclosed on
 * the entry page and in the membership terms.
 */
@Schema({ collection: 'visitrecords', autoIndex: false, versionKey: false })
export class VisitRecord {
  @Prop({ type: String, enum: VISIT_KINDS, required: true })
  kind: VisitKind;

  @Prop({ type: Date, required: true })
  at: Date;

  @Prop({ type: String, maxlength: 64 })
  ip?: string;

  @Prop({ type: String, maxlength: 500 })
  userAgent?: string;
}

export type VisitRecordDocument = HydratedDocument<VisitRecord>;
export const VisitRecordSchema = SchemaFactory.createForClass(VisitRecord);
makeAppendOnly(VisitRecordSchema, 'visitrecords');

VisitRecordSchema.index({ at: -1 });
