import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const BLOCK_SECTIONS = [
  'bio',
  'beliefs',
  'considering',
  'texts',
  'contact',
  'legal',
] as const;
export type BlockSection = (typeof BLOCK_SECTIONS)[number];

export const BLOCK_KINDS = [
  'heading',
  'paragraph',
  'outline-item',
  'image',
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/**
 * One paragraph (or heading, outline item, image) of a profile.
 *
 * Its text lives in `blockversions`; this row only says where the block sits
 * and which version is current. Comments and votes point at `blockId`, so an
 * edit never orphans them.
 */
@Schema({ collection: 'profileblocks', timestamps: true, autoIndex: false })
export class ProfileBlock {
  @Prop({ type: Types.ObjectId, required: true })
  profileId: Types.ObjectId;

  /** Stable public id, never reused, even after the block is removed. */
  @Prop({ type: String, required: true })
  blockId: string;

  @Prop({ type: String, enum: BLOCK_SECTIONS, required: true })
  section: BlockSection;

  @Prop({ type: String, enum: BLOCK_KINDS, required: true })
  kind: BlockKind;

  /** The belief tab this block belongs to; set only in the beliefs section. */
  @Prop({ type: String })
  tabId?: string;

  /** Outline label as written, e.g. "II." or "A."; empty when unnumbered. */
  @Prop({ type: String, default: '', maxlength: 20 })
  label: string;

  @Prop({ type: Number, required: true, min: 0 })
  order: number;

  @Prop({ type: Types.ObjectId })
  currentVersionId?: Types.ObjectId;

  /** Sequence number of `currentVersionId`; only ever moves forward. */
  @Prop({ type: Number, default: 0, min: 0 })
  currentVersionSeq: number;

  @Prop({ type: Date })
  removedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export type ProfileBlockDocument = HydratedDocument<ProfileBlock>;
export const ProfileBlockSchema = SchemaFactory.createForClass(ProfileBlock);

ProfileBlockSchema.index({ blockId: 1 }, { unique: true });
ProfileBlockSchema.index({ profileId: 1, section: 1, order: 1 });
ProfileBlockSchema.index(
  { tabId: 1, order: 1 },
  { partialFilterExpression: { tabId: { $type: 'string' } } },
);

ProfileBlockSchema.pre('validate', function () {
  if (this.tabId && this.section !== 'beliefs') {
    this.invalidate(
      'tabId',
      'Only blocks in the beliefs section belong to a tab.',
    );
  }
});
