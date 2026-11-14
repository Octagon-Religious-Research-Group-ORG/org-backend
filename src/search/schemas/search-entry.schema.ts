import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * - `member`: a member page's display name;
 * - `belief-title`: a belief tab's title;
 * - `belief-text`: one text block of a belief tab;
 * - `page`: one text of a published ORG CMS page (title, subtitle or block).
 */
export const SEARCH_ENTRY_KINDS = [
  'member',
  'belief-title',
  'belief-text',
  'page',
] as const;
export type SearchEntryKind = (typeof SEARCH_ENTRY_KINDS)[number];

/**
 * One searchable text (Chunk 15). A copy, kept so ONE Atlas Search index (and
 * one `$text` index) covers names, beliefs and ORG pages together.
 *
 * It is never trusted for who may see it: every search joins each entry back
 * to its live rows (the page's access, the tab, the block's newest version,
 * the published revision) and drops it unless the copy is exactly what the
 * site shows now (`search-pipeline.ts`). A stale copy can therefore only be
 * missing from results, never shown. Comments are not copied.
 */
@Schema({
  collection: 'searchentries',
  timestamps: true,
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class SearchEntry {
  /** `member:<profileId>`, `title:<tabId>`, `text:<blockId>`, `page:<pageId>:<part>`. */
  @Prop({ type: String, required: true })
  _id: string;

  @Prop({ type: String, enum: SEARCH_ENTRY_KINDS, required: true })
  kind: SearchEntryKind;

  @Prop({ type: String, required: true, maxlength: 20_000 })
  text: string;

  /** The member page, for `member` and belief entries. */
  @Prop({ type: Types.ObjectId })
  profileId?: Types.ObjectId;

  @Prop({ type: String })
  tabId?: string;

  /** For `belief-text`: the block and the version `text` was copied from. */
  @Prop({ type: String })
  blockId?: string;

  @Prop({ type: Number, min: 1 })
  seq?: number;

  /** For `page`: the CMS page, the part, and its published revision. */
  @Prop({ type: String })
  pageId?: string;

  @Prop({ type: String })
  part?: string;

  @Prop({ type: Number, min: 1 })
  revision?: number;

  createdAt?: Date;
  updatedAt?: Date;
}

export type SearchEntryDocument = HydratedDocument<SearchEntry>;
export const SearchEntrySchema = SchemaFactory.createForClass(SearchEntry);

/** The `$text` fallback: no stemming and no stop words, like Atlas's standard analyzer. */
export const TEXT_INDEX_NAME = 'search_text_fallback';
SearchEntrySchema.index(
  { text: 'text' },
  { name: TEXT_INDEX_NAME, default_language: 'none' },
);
// The indexer replaces one tab's or one CMS page's entries at a time.
SearchEntrySchema.index({ tabId: 1 }, { sparse: true });
SearchEntrySchema.index({ pageId: 1 }, { sparse: true });
