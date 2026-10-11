import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Who can see a profile (plan D4 + §2d):
 * - `public`: everyone, and listed in the directory;
 * - `members`: name visible to everyone, content to signed-in members only;
 * - `unlisted`: Tripp's "Private" — never listed in the Members Community,
 *   though the member keeps a full timestamped record.
 */
export const PROFILE_VISIBILITIES = ['public', 'members', 'unlisted'] as const;
export type ProfileVisibility = (typeof PROFILE_VISIBILITIES)[number];

export const PROFILE_SOURCES = ['migrated', 'native'] as const;
export type ProfileSource = (typeof PROFILE_SOURCES)[number];

/** Lowercase words joined by single hyphens, 2–80 characters. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

@Schema({ _id: false })
export class LegacySource {
  @Prop({ type: String, required: true })
  pagesUrl: string;

  @Prop({ type: Date, required: true })
  importedAt: Date;
}

export const LegacySourceSchema = SchemaFactory.createForClass(LegacySource);

/**
 * A member's public-facing page. Separate from `MemberProfile` (the account
 * and orders record) because a migrated profile exists before anyone has
 * claimed it, so it cannot require a login.
 */
@Schema({ collection: 'socialprofiles', timestamps: true, autoIndex: false })
export class SocialProfile {
  @Prop({
    type: String,
    required: true,
    minlength: 2,
    maxlength: 80,
    match: SLUG_PATTERN,
  })
  slug: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  displayName: string;

  @Prop({ type: [String], default: [] })
  imageIds: string[];

  @Prop({
    type: String,
    enum: PROFILE_VISIBILITIES,
    required: true,
    default: 'members',
  })
  visibility: ProfileVisibility;

  /** Clerk user id of the member who owns the page; absent until claimed. */
  @Prop({ type: String })
  ownerUserId?: string;

  @Prop({ type: String, enum: PROFILE_SOURCES, required: true })
  source: ProfileSource;

  @Prop({ type: LegacySourceSchema })
  legacy?: LegacySource;

  @Prop({ type: Date })
  deletedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export type SocialProfileDocument = HydratedDocument<SocialProfile>;
export const SocialProfileSchema = SchemaFactory.createForClass(SocialProfile);

SocialProfileSchema.index({ slug: 1 }, { unique: true });
// One profile per owner, but any number of unclaimed profiles: a plain unique
// index would treat every missing ownerUserId as the same value.
SocialProfileSchema.index(
  { ownerUserId: 1 },
  {
    unique: true,
    partialFilterExpression: { ownerUserId: { $type: 'string' } },
  },
);
SocialProfileSchema.index({ visibility: 1, deletedAt: 1, displayName: 1 });
