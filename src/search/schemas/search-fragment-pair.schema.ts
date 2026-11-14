import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * "This searcher has already been counted for this term in this window"
 * (Chunk 15, round-2 review M-A), kept so a restart of the server does not
 * count the same person again.
 *
 * The `_id` is `<window>|<hash>`, the hash an HMAC of (searcher, term) under
 * a key derived from the server secret and the window (`fragment-keys.ts`).
 * The secret is not in the database, so the database alone cannot recover a
 * searcher, test whether someone searched a term, or tell which term a row
 * is about. No term, no timestamp other than the window's expiry, and no
 * searcher is stored; rows of different terms by one person are unrelated
 * hashes. Each row deletes itself a day after its window ends.
 */
@Schema({
  collection: 'searchfragmentpairs',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class SearchFragmentPair {
  @Prop({ type: String, required: true })
  _id: string;

  /** The window's end plus one day: the same for every row of the window. */
  @Prop({ type: Date, required: true })
  expiresAt: Date;
}

export type SearchFragmentPairDocument = HydratedDocument<SearchFragmentPair>;
export const SearchFragmentPairSchema =
  SchemaFactory.createForClass(SearchFragmentPair);

SearchFragmentPairSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
