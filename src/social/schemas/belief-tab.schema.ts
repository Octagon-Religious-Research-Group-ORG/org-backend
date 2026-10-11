import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * - `confirmed`: written by the member, or an imported split they accepted;
 * - `imported-review`: split automatically or by hand during the Apple Pages
 *   import. Shown with "Imported, please review" until the owner accepts,
 *   merges, re-splits or renames it (plan §2c).
 */
export const TAB_REVIEW_STATUSES = ['confirmed', 'imported-review'] as const;
export type TabReviewStatus = (typeof TAB_REVIEW_STATUSES)[number];

/**
 * One perforated tab on a profile: one belief (plan §2c). Its paragraphs are
 * the `profileblocks` carrying this `tabId`, and comments written on the tab
 * carry it too, so a comment always belongs to exactly one belief.
 */
@Schema({ collection: 'belieftabs', timestamps: true, autoIndex: false })
export class BeliefTab {
  @Prop({ type: Types.ObjectId, required: true })
  profileId: Types.ObjectId;

  /** Stable public id, never reused, even after the tab is removed. */
  @Prop({ type: String, required: true })
  tabId: string;

  /** The label under the tab's art, e.g. "Theology" or "I. God". */
  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  title: string;

  @Prop({ type: Number, required: true, min: 0 })
  order: number;

  @Prop({
    type: String,
    enum: TAB_REVIEW_STATUSES,
    required: true,
    default: 'confirmed',
  })
  reviewStatus: TabReviewStatus;

  @Prop({ type: Date })
  removedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export type BeliefTabDocument = HydratedDocument<BeliefTab>;
export const BeliefTabSchema = SchemaFactory.createForClass(BeliefTab);

BeliefTabSchema.index({ tabId: 1 }, { unique: true });
BeliefTabSchema.index({ profileId: 1, order: 1 });
