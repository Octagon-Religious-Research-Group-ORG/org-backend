import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { makeAppendOnly } from '../../social/append-only';

/**
 * One member's agreement to the membership terms. **Append-only**: a later
 * agreement is a new record, so the history of what each member accepted, and
 * when, can never be rewritten.
 */
@Schema({ collection: 'consentrecords', autoIndex: false, versionKey: false })
export class ConsentRecord {
  @Prop({ type: String, required: true, immutable: true })
  userId: string;

  @Prop({ type: String, required: true, immutable: true })
  termsVersion: string;

  @Prop({ type: String, required: true, match: /^[0-9a-f]{64}$/ })
  termsHash: string;

  @Prop({ type: Date, required: true, immutable: true })
  acceptedAt: Date;

  /** Disclosed in the terms themselves ("records"). */
  @Prop({ type: String, maxlength: 64 })
  ip?: string;

  @Prop({ type: String, maxlength: 500 })
  userAgent?: string;
}

export type ConsentRecordDocument = HydratedDocument<ConsentRecord>;
export const ConsentRecordSchema = SchemaFactory.createForClass(ConsentRecord);
makeAppendOnly(ConsentRecordSchema, 'consentrecords');

ConsentRecordSchema.index({ userId: 1, acceptedAt: -1 });
