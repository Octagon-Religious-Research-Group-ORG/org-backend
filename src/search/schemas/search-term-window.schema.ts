import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * How many different searchers used one normalised term in one fixed window
 * of `SEARCH_FRAGMENT_WINDOW_DAYS` days (Chunk 15, plan D21; review H1b: a
 * person searching on several days of the window counts once). Aggregate
 * only: no user id, address, session or query-with-person ever reaches this
 * row, so nothing here says WHO searched. Only terms whose every word is in
 * content a signed-out reader can see are counted. The row's `_id` is
 * `<window>|<term>`, so it does not depend on `db:indexes`.
 */
@Schema({
  collection: 'searchtermwindows',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class SearchTermWindow {
  @Prop({ type: String, required: true })
  _id: string;

  @Prop({ type: String, required: true })
  term: string;

  /** Days since 1970-01-01 (UTC), divided by the window length, rounded down. */
  @Prop({ type: Number, required: true, min: 0 })
  window: number;

  /** Different searchers in that window (deduplicated in `searchfragmentpairs`, see `fragment-keys.ts`). */
  @Prop({ type: Number, required: true, min: 0 })
  searchers: number;

  @Prop({ type: Date, required: true })
  expiresAt: Date;
}

export type SearchTermWindowDocument = HydratedDocument<SearchTermWindow>;
export const SearchTermWindowSchema =
  SchemaFactory.createForClass(SearchTermWindow);

// A window's row deletes itself once the window after it has ended.
SearchTermWindowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
SearchTermWindowSchema.index({ window: 1, term: 1 });
