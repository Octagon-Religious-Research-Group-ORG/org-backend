import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/** How long a delivered webhook id is remembered (Svix retries for ~3 days). */
export const WEBHOOK_EVENT_KEEP_DAYS = 30;

/**
 * A Clerk webhook delivery already handled (Chunk 17). Its `_id` is the Svix
 * message id, so a redelivery is a duplicate key and is answered without
 * doing the work again. Holds no person: only the id, the type and when.
 */
@Schema({
  collection: 'webhookevents',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class WebhookEvent {
  @Prop({ type: String, required: true })
  _id: string;

  @Prop({ type: String, required: true })
  type: string;

  @Prop({ type: Date, required: true })
  receivedAt: Date;

  /** TTL: removed by the database after {@link WEBHOOK_EVENT_KEEP_DAYS}. */
  @Prop({ type: Date, required: true })
  expiresAt: Date;
}

export type WebhookEventDocument = HydratedDocument<WebhookEvent>;
export const WebhookEventSchema = SchemaFactory.createForClass(WebhookEvent);

WebhookEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
