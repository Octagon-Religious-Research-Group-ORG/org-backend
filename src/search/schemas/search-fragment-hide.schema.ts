import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * An admin's decision about one Suggested Fragment (Chunk 15): hidden or
 * shown again. The row's `_id` is the normalised term. Each change is also
 * in the moderation log, which is the record; this row is only the state.
 */
@Schema({
  collection: 'searchfragmenthides',
  autoIndex: false,
  autoCreate: false,
  versionKey: false,
})
export class SearchFragmentHide {
  @Prop({ type: String, required: true })
  _id: string;

  @Prop({ type: Boolean, required: true })
  hidden: boolean;

  @Prop({ type: Date, required: true })
  at: Date;

  /** Clerk user id of the admin. Admins only. */
  @Prop({ type: String, required: true })
  by: string;
}

export type SearchFragmentHideDocument = HydratedDocument<SearchFragmentHide>;
export const SearchFragmentHideSchema =
  SchemaFactory.createForClass(SearchFragmentHide);
