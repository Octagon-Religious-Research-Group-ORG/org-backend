import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { MAX_BLOCK_TEXT_LENGTH } from './block-version.schema';

export const COMMENT_SOURCES = ['migrated', 'native'] as const;
export type CommentSource = (typeof COMMENT_SOURCES)[number];

export const MAX_COMMENT_LENGTH = 10_000;
// As long as a paragraph: one real highlight spans 6,378 characters.
export const MAX_ANCHOR_TEXT_LENGTH = 20_000;

/**
 * - `comment`: a comment or a reply;
 * - `suggestion`: "Suggest a rewording" (plan §2d item 6): new full text for
 *   one belief's text, which its owner can accept or decline.
 */
export const COMMENT_KINDS = ['comment', 'suggestion'] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

/**
 * - `pending`: waiting for the page owner;
 * - `accepting`: an accept is being written (a short lock, so a decline in
 *   another window cannot cross it); read as pending;
 * - `accepted` / `declined`: decided, with who and when.
 */
export const SUGGESTION_STATUSES = [
  'pending',
  'accepting',
  'accepted',
  'declined',
] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

/** A rewording suggestion's own fields, on its comment row. */
@Schema({ _id: false, versionKey: false })
export class Suggestion {
  /** The whole proposed text of the belief, cleaned as an edit is. */
  @Prop({ type: String, required: true, maxlength: MAX_BLOCK_TEXT_LENGTH })
  proposedText: string;

  /** The belief text's version the suggestion was written against. */
  @Prop({ type: Number, required: true, min: 0 })
  baseSeq: number;

  @Prop({
    type: String,
    enum: SUGGESTION_STATUSES,
    required: true,
    default: 'pending',
  })
  status: SuggestionStatus;

  /** The accept holding the lock, and since when. */
  @Prop({ type: String })
  lockId?: string;

  @Prop({ type: Date })
  lockedAt?: Date;

  /** Who accepted or declined it (Clerk user id), and when (server time). */
  @Prop({ type: String })
  decidedBy?: string;

  @Prop({ type: Date })
  decidedAt?: Date;

  /** The belief text's version that accepting it wrote. */
  @Prop({ type: Number, min: 1 })
  resultSeq?: number;
}
export const SuggestionSchema = SchemaFactory.createForClass(Suggestion);

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
@Schema({
  collection: 'comments',
  timestamps: true,
  autoIndex: false,
  autoCreate: false,
})
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

  /**
   * The text as last saved. For a site member's comment its versions in
   * `commentversions` are the record and this is a copy for reading; a
   * suggestion's optional note may be empty.
   */
  @Prop({
    type: String,
    required: function (this: { kind?: CommentKind }) {
      return this.kind !== 'suggestion';
    },
    default: '',
    maxlength: MAX_COMMENT_LENGTH,
  })
  body: string;

  @Prop({ type: String, enum: COMMENT_SOURCES, required: true })
  source: CommentSource;

  /** Absent on rows written before Chunk 9, which read as `comment`. */
  @Prop({ type: String, enum: COMMENT_KINDS })
  kind?: CommentKind;

  /** Which comment version `body` shows; only ever rises. Native only. */
  @Prop({ type: Number, min: 1 })
  bodySeq?: number;

  /** Server time of the newest edit, when there was one. */
  @Prop({ type: Date })
  editedAt?: Date;

  /**
   * Written by an admin with no approved page of their own (Chunk 9), so the
   * thread can say "ORG admin" instead of a page name.
   */
  @Prop({ type: Boolean })
  writtenAsAdmin?: boolean;

  @Prop({ type: SuggestionSchema })
  suggestion?: Suggestion;

  /**
   * Edits holding a turn on this comment (Chunk 9 review): a removal waits
   * for them, so no version is written after a removal. Each is cleared when
   * its edit ends, or after five minutes if the edit died.
   */
  @Prop({
    type: [{ _id: false, id: { type: String }, at: { type: Date } }],
    default: undefined,
  })
  editTurns?: Array<{ id: string; at: Date }>;

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
  if ((this.kind === 'suggestion') !== Boolean(this.suggestion)) {
    this.invalidate(
      'suggestion',
      'A rewording suggestion, and only one, carries suggestion fields.',
    );
  }
});

CommentSchema.index({ commentId: 1 }, { unique: true });
CommentSchema.index({ profileId: 1, tabId: 1, createdAt: 1 });
// A thread page: top-level comments after a (createdAt, _id) cursor (Chunk 9).
CommentSchema.index({ profileId: 1, tabId: 1, createdAt: 1, _id: 1 });
CommentSchema.index(
  { parentCommentId: 1 },
  { partialFilterExpression: { parentCommentId: { $type: 'string' } } },
);
