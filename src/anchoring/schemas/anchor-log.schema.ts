import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { makeAppendOnly } from '../../social/append-only';

/**
 * One entry of the daily anchor log (Chunk 16b). **Append-only**, and only
 * a CACHE: the log's truth is its signed, published checkpoints, which
 * every reader checks these rows against.
 *
 * `_id` is the entry's index (0, 1, 2, ...) and `day` is unique, so two
 * runs appending at once cannot both write entry N, and no day can enter
 * the log twice: the second insert is a duplicate key.
 */
@Schema({
  collection: 'anchorlogleaves',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class AnchorLogLeaf {
  @Prop({ type: Number, required: true })
  _id: number;

  /** The anchor's `_id`, the UTC day it was made. */
  @Prop({ type: String, required: true, immutable: true })
  day: string;

  /** The canonical day record (`day-record.ts`); the leaf data. */
  @Prop({ type: String, required: true, immutable: true })
  record: string;

  /** SHA-256(0x00 || record), hex. */
  @Prop({
    type: String,
    required: true,
    match: /^[0-9a-f]{64}$/,
    immutable: true,
  })
  hash: string;
}

export type AnchorLogLeafDocument = HydratedDocument<AnchorLogLeaf>;
export const AnchorLogLeafSchema = SchemaFactory.createForClass(AnchorLogLeaf);
AnchorLogLeafSchema.index({ day: 1 }, { unique: true });
makeAppendOnly(AnchorLogLeafSchema, 'anchorlogleaves');

/**
 * A checkpoint this server SIGNED (Chunk 16b). **Append-only.** Kept so it
 * never signs one inconsistent with an earlier one (c2sp.org/tlog-checkpoint:
 * "A log or cosigner MUST NOT sign any checkpoint which is inconsistent with
 * any checkpoint it previously signed"). `_id` is the tree size: one
 * checkpoint per size. Unsigned checkpoints are never stored.
 */
@Schema({
  collection: 'anchorlogcheckpoints',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class AnchorLogCheckpoint {
  @Prop({ type: Number, required: true })
  _id: number;

  /** The tree's root, hex. */
  @Prop({
    type: String,
    required: true,
    match: /^[0-9a-f]{64}$/,
    immutable: true,
  })
  root: string;

  /** The whole signed note, as `GET /anchors/checkpoint` serves it. */
  @Prop({ type: String, required: true, immutable: true })
  note: string;

  /** The verifier key it was signed with (public). */
  @Prop({ type: String, required: true, immutable: true })
  verifierKey: string;

  @Prop({ type: Date, required: true, immutable: true })
  signedAt: Date;
}

export type AnchorLogCheckpointDocument = HydratedDocument<AnchorLogCheckpoint>;
export const AnchorLogCheckpointSchema =
  SchemaFactory.createForClass(AnchorLogCheckpoint);
makeAppendOnly(AnchorLogCheckpointSchema, 'anchorlogcheckpoints');
