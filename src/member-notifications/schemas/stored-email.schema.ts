import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/**
 * The email exactly as it was first sent under a key (Chunk 14 review L3):
 * a retry or a takeover replays it, so one idempotency key never carries
 * two bodies. Links and fixed wording only: never member text, never the
 * address.
 */
@Schema({ _id: false })
export class StoredEmail {
  @Prop({ type: String, required: true })
  subject: string;

  @Prop({ type: [String], required: true })
  lines: string[];

  @Prop({ type: Object, required: true })
  headers: Record<string, string>;
}

export const StoredEmailSchema = SchemaFactory.createForClass(StoredEmail);
