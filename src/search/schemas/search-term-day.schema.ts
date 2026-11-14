import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * How many different searchers used one normalised term on one UTC day
 * (Chunk 15, plan D21). Aggregate only: no user id, address, session or
 * query-with-person ever reaches this row, so nothing here says WHO searched.
 * Only terms that matched content a signed-out reader can see are counted.
 * The row's `_id` is `<day>|<term>`, so it does not depend on `db:indexes`.
 */
@Schema({
  collection: 'searchtermdays',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class SearchTermDay {
  @Prop({ type: String, required: true })
  _id: string;

  @Prop({ type: String, required: true })
  term: string;

  /** The UTC day, `YYYY-MM-DD`. */
  @Prop({ type: String, required: true })
  day: string;

  /** Different searchers that day (see `searcher-counter.ts`). */
  @Prop({ type: Number, required: true, min: 0 })
  searchers: number;

  @Prop({ type: Date, required: true })
  expiresAt: Date;
}

export type SearchTermDayDocument = HydratedDocument<SearchTermDay>;
export const SearchTermDaySchema = SchemaFactory.createForClass(SearchTermDay);

// Rows outside the window delete themselves.
SearchTermDaySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
SearchTermDaySchema.index({ day: 1, term: 1 });
