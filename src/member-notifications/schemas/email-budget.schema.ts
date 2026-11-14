import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Emails this backend sent on one UTC day (Chunk 14), so the shared Resend
 * free tier (100 a day for the TEST and live sites together) is never run
 * over by notifications. The row's `_id` is the day, so it does not depend on
 * `db:indexes` having run (the Chunk 13 report-quota pattern).
 */
@Schema({
  collection: 'emailbudget',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class EmailBudgetDay {
  /** The UTC day, `YYYY-MM-DD`. */
  @Prop({ type: String, required: true })
  _id: string;

  @Prop({ type: Number, required: true, min: 0 })
  n: number;

  /** First time a send was refused that day for want of budget. */
  @Prop({ type: Date })
  limitHitAt?: Date;

  @Prop({ type: Date, required: true })
  expiresAt: Date;
}

export type EmailBudgetDocument = HydratedDocument<EmailBudgetDay>;
export const EmailBudgetDaySchema =
  SchemaFactory.createForClass(EmailBudgetDay);

// Old days delete themselves.
EmailBudgetDaySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
