import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/** The one lock document's `_id`. */
export const RUN_LOCK_ID = 'anchoring-run';

/**
 * The anchoring run lock (Chunk 16 review round 7): ONE document, so only
 * one `run()` executes at a time, whichever caller started it (the hourly
 * scheduler, an admin's "Run now", any server instance). Held under a lease
 * the run renews between its steps; a holder that died is taken over once
 * its lease runs out. The per-anchor leases stay as a second line.
 */
@Schema({
  collection: 'anchorrunlocks',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class AnchorRunLock {
  @Prop({ type: String, required: true })
  _id: string;

  /** The run holding it; absent when free. */
  @Prop({ type: String })
  holder?: string;

  /** When the holder's lease runs out (server clock). */
  @Prop({ type: Date })
  until?: Date;
}

export type AnchorRunLockDocument = HydratedDocument<AnchorRunLock>;
export const AnchorRunLockSchema = SchemaFactory.createForClass(AnchorRunLock);
