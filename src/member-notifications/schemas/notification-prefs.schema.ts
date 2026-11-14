import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { CATEGORIES, type Category } from '../notification-kinds';

/**
 * One member's email settings (Chunk 14). A member with no row has the
 * defaults: every category on, the daily digest on, immediate emails on
 * (`DEFAULT_PREFS`). Never holds an email address: that is read from Clerk
 * when an email is sent.
 */
@Schema({
  collection: 'notificationprefs',
  timestamps: true,
  autoIndex: false,
  autoCreate: false,
})
export class NotificationPrefsRow {
  /** Clerk user id. */
  @Prop({ type: String, required: true })
  userId: string;

  /** Categories turned off. */
  @Prop({ type: [String], enum: CATEGORIES, default: [] })
  off: Category[];

  @Prop({ type: Boolean, required: true, default: true })
  digest: boolean;

  @Prop({ type: Boolean, required: true, default: true })
  immediate: boolean;

  @Prop({ type: Boolean, required: true, default: true })
  adminImmediate: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export type NotificationPrefsDocument = HydratedDocument<NotificationPrefsRow>;
export const NotificationPrefsRowSchema =
  SchemaFactory.createForClass(NotificationPrefsRow);

// One row per member.
NotificationPrefsRowSchema.index({ userId: 1 }, { unique: true });
