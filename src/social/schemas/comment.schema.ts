import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const COMMENT_SOURCES = ['migrated', 'native'] as const;
export type CommentSource = (typeof COMMENT_SOURCES)[number];

export const MAX_COMMENT_LENGTH = 10_000;
export const MAX_ANCHOR_TEXT_LENGTH = 4_000;

/**
 * A comment on a profile.
 *
 * - On a belief tab when `tabId` is set (plan §2c), otherwise on the profile
 *   itself (bio, contact, or an imported comment whose highlighted text could
 *   not be found; those keep `anchorText` and are listed in the import report).
 * - A reply carries `parentCommentId`.
 * - Exactly one author: `authorUserId` (a site account) or `legacyAuthorName`
 *   (a name typed into Apple Pages, which proves no identity; linking it to an
 *   account is a separate admin-approved step, plan Q5).
 * - `legacyCreatedAt` is the date Apple Pages recorded. It is shown as such and
 *   never treated as proof; `createdAt` is when this row was written.
 */
@Schema({ collection: 'comments', timestamps: true, autoIndex: false })
export class Comment {
  /** Stable public id, never reused. */
  @Prop({ type: String, required: true })
  commentId: string;

  @Prop({ type: Types.ObjectId, required: true })
  profileId: Types.ObjectId;

  @Prop({ type: String })
  tabId?: string;

  @Prop({ type: String })
  parentCommentId?: string;

  /** The paragraph the comment highlights, when known. */
  @Prop({ type: String })
  anchorBlockId?: string;

  /** The highlighted text exactly as it was, kept even if the paragraph changes. */
  @Prop({ type: String, maxlength: MAX_ANCHOR_TEXT_LENGTH })
  anchorText?: string;

  @Prop({ type: String })
  authorUserId?: string;

  @Prop({ type: String, trim: true, maxlength: 120 })
  legacyAuthorName?: string;

  @Prop({ type: String, required: true, maxlength: MAX_COMMENT_LENGTH })
  body: string;

  @Prop({ type: String, enum: COMMENT_SOURCES, required: true })
  source: CommentSource;

  @Prop({ type: Date })
  legacyCreatedAt?: Date;

  @Prop({ type: Date })
  removedAt?: Date;

  @Prop({ type: String })
  removedBy?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export type CommentDocument = HydratedDocument<Comment>;
export const CommentSchema = SchemaFactory.createForClass(Comment);

CommentSchema.pre('validate', function () {
  const authors = [this.authorUserId, this.legacyAuthorName].filter(
    (value) => typeof value === 'string' && value.length > 0,
  );
  if (authors.length !== 1) {
    this.invalidate(
      'authorUserId',
      'A comment needs exactly one author: authorUserId or legacyAuthorName.',
    );
  }
  if (this.source === 'native' && this.legacyAuthorName) {
    this.invalidate(
      'legacyAuthorName',
      'Only migrated comments can have a legacy author name.',
    );
  }
});

CommentSchema.index({ commentId: 1 }, { unique: true });
CommentSchema.index({ profileId: 1, tabId: 1, createdAt: 1 });
CommentSchema.index(
  { parentCommentId: 1 },
  { partialFilterExpression: { parentCommentId: { $type: 'string' } } },
);
