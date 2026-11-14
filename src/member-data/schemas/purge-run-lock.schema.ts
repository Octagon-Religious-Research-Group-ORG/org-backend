import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/** The one lock document's `_id`. */
export const PURGE_LOCK_ID = 'member-purge';

/**
 * The five-year purge's run lock (Chunk 17), the same pattern as the
 * anchoring lock (`anchorrunlocks`, Chunk 16 round 7): ONE document, so one
 * purge runs at a time across the hourly tick, an admin and every server
 * instance; a holder that died is taken over once its lease runs out.
 * `lastDay` makes it a daily job: a run for a day already done does nothing.
 */
@Schema({
  collection: 'purgerunlocks',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class PurgeRunLock {
  @Prop({ type: String, required: true })
  _id: string;

  @Prop({ type: String })
  holder?: string;

  @Prop({ type: Date })
  until?: Date;

  /** The UTC day (`YYYY-MM-DD`) of the last run that finished. */
  @Prop({ type: String })
  lastDay?: string;
}

export type PurgeRunLockDocument = HydratedDocument<PurgeRunLock>;
export const PurgeRunLockSchema = SchemaFactory.createForClass(PurgeRunLock);
