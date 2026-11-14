import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { makeAppendOnly } from '../../social/append-only';

/** The two kinds of version the daily anchor covers (plan §6, §2d). */
export const ANCHORED_KINDS = ['block', 'comment'] as const;
export type AnchoredKind = (typeof ANCHORED_KINDS)[number];

/** `_id` of a version's claim: one per version, ever. */
export function leafId(kind: AnchoredKind, versionId: Types.ObjectId | string) {
  return `${kind === 'block' ? 'b' : 'c'}:${String(versionId)}`;
}

/**
 * A version's place in one daily anchor (Chunk 16). **Append-only**: written
 * once by the run that anchors the version, never changed or removed.
 *
 * Its `_id` names the version (`b:<id>` for `blockversions`, `c:<id>` for
 * `commentversions`), so a version can be claimed by ONE anchor only, even
 * with two server instances building at the same moment: the second insert
 * is a duplicate key and that version is simply not in the second batch.
 * Versions are append-only too, so nothing is ever written on them; this
 * row is how "already anchored" is known.
 */
@Schema({
  collection: 'anchorleaves',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class AnchorLeaf {
  @Prop({ type: String, required: true })
  _id: string;

  /** The anchor (its UTC date, `YYYY-MM-DD`). */
  @Prop({ type: String, required: true, immutable: true })
  anchorId: string;

  @Prop({
    type: String,
    enum: ANCHORED_KINDS,
    required: true,
    immutable: true,
  })
  kind: AnchoredKind;

  @Prop({ type: Types.ObjectId, required: true, immutable: true })
  versionId: Types.ObjectId;

  /** The version's hash as it was when anchored. */
  @Prop({
    type: String,
    required: true,
    match: /^[0-9a-f]{64}$/,
    immutable: true,
  })
  versionHash: string;

  /** The version's own server time. */
  @Prop({ type: Date, required: true, immutable: true })
  versionCreatedAt: Date;
}

export type AnchorLeafDocument = HydratedDocument<AnchorLeaf>;
export const AnchorLeafSchema = SchemaFactory.createForClass(AnchorLeaf);

// A batch's leaves; and "is this version anchored" by version id.
AnchorLeafSchema.index({ anchorId: 1 });
AnchorLeafSchema.index({ versionId: 1 });

makeAppendOnly(AnchorLeafSchema, 'anchorleaves');
