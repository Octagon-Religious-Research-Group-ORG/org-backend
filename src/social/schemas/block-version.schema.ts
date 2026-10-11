import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { makeAppendOnly } from '../append-only';

/** Longest text one version may hold. */
export const MAX_BLOCK_TEXT_LENGTH = 20_000;

/**
 * One saved state of a block's text. **Append-only** (plan D8, D11): a version
 * is never changed or removed; an edit is a new version.
 *
 * Versions of a block form a hash chain: `hash` covers this version's fields
 * plus `prevHash`, the hash of version `seq - 1`. The unique (blockId, seq)
 * index makes two concurrent saves unable to fork the chain: one insert wins,
 * the other retries on top of it.
 */
@Schema({
  collection: 'blockversions',
  autoIndex: false,
  versionKey: false,
})
export class BlockVersion {
  @Prop({ type: String, required: true, immutable: true })
  blockId: string;

  /** 1 for the first version of a block, then +1 per save. */
  @Prop({ type: Number, required: true, min: 1, immutable: true })
  seq: number;

  @Prop({
    type: String,
    required: true,
    maxlength: MAX_BLOCK_TEXT_LENGTH,
    immutable: true,
  })
  text: string;

  /** Clerk user id, or `system:import` for migrated text. */
  @Prop({ type: String, required: true, immutable: true })
  authorUserId: string;

  /** Server time; part of the hash. */
  @Prop({ type: Date, required: true, immutable: true })
  createdAt: Date;

  @Prop({
    type: String,
    required: true,
    match: /^[0-9a-f]{64}$/,
    immutable: true,
  })
  prevHash: string;

  @Prop({
    type: String,
    required: true,
    match: /^[0-9a-f]{64}$/,
    immutable: true,
  })
  hash: string;
}

export type BlockVersionDocument = HydratedDocument<BlockVersion>;
export const BlockVersionSchema = SchemaFactory.createForClass(BlockVersion);

BlockVersionSchema.index({ blockId: 1, seq: 1 }, { unique: true });
// The daily anchor (plan §6) selects one day's new versions by time.
BlockVersionSchema.index({ createdAt: 1 });

makeAppendOnly(BlockVersionSchema, 'blockversions');
