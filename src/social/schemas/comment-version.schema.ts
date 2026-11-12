import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { makeAppendOnly } from '../append-only';
import { MAX_BLOCK_TEXT_LENGTH } from './block-version.schema';
import { MAX_COMMENT_LENGTH } from './comment.schema';

/**
 * Longest text one comment version may hold. A suggestion's version records
 * its note AND the proposed belief text as one JSON array, so this covers the
 * worst encoding of both at their own limits (Chunk 9 review item 3).
 *
 * Both are stored cleaned (`normaliseFieldText`): no control characters but
 * tab, line feed and carriage return, and no lone surrogates. JSON then
 * writes at most two characters for one (a quote, a backslash, a tab, a line
 * feed or a carriage return each become two); its six-character escape is
 * only for the characters cleaning removed. The 1,000 covers the label, the tab id, the version number and
 * the punctuation.
 */
export const MAX_COMMENT_VERSION_TEXT =
  2 * (MAX_BLOCK_TEXT_LENGTH + MAX_COMMENT_LENGTH) + 1_000;

/**
 * One saved state of a site member's comment (Chunk 9). **Append-only**, like
 * `blockversions` (plan D8, and Tripp: "each comment is a timestamped
 * record"): an edit is a new version, never a change to an old one.
 *
 * The versions of a comment form a hash chain with the same rules as block
 * versions, under their own hash scheme (`COMMENT_HASH_SCHEME`). The unique
 * (commentId, seq) index makes two concurrent edits unable to fork it. The
 * daily anchor (plan §6, Chunk 16) selects a day's new rows by `createdAt`.
 *
 * Imported Apple Pages comments have no versions: they were never written on
 * this site, and the import record is their evidence.
 */
@Schema({
  collection: 'commentversions',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class CommentVersion {
  @Prop({ type: String, required: true, immutable: true })
  commentId: string;

  /** 1 for the comment as first posted, then +1 per edit. */
  @Prop({ type: Number, required: true, min: 1, immutable: true })
  seq: number;

  @Prop({
    type: String,
    required: true,
    maxlength: MAX_COMMENT_VERSION_TEXT,
    immutable: true,
  })
  text: string;

  /** Clerk user id of the comment's author. */
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

export type CommentVersionDocument = HydratedDocument<CommentVersion>;
export const CommentVersionSchema =
  SchemaFactory.createForClass(CommentVersion);

CommentVersionSchema.index({ commentId: 1, seq: 1 }, { unique: true });
CommentVersionSchema.index({ createdAt: 1 });

makeAppendOnly(CommentVersionSchema, 'commentversions');
