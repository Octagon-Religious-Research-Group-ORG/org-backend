import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Who can see a profile (plan D4, §2b D11, §2d), from widest to narrowest:
 * - `public`: everyone, guests and anyone holding the link included;
 * - `members`: every member, anonymous members included;
 * - `named-members`: only members who joined under their own name (Tripp,
 *   D11: "some members may not want an anonymous member or guest to see
 *   their page");
 * - `unlisted`: Tripp's "Private" — never listed in the Members Community,
 *   though the member keeps a full timestamped record.
 */
export const PROFILE_VISIBILITIES = [
  'public',
  'members',
  'named-members',
  'unlisted',
] as const;
export type ProfileVisibility = (typeof PROFILE_VISIBILITIES)[number];

/**
 * - `pending`: a new member's page waiting for an admin (Tripp's approval
 *   step, plan §2d); shown only to its owner and admins;
 * - `approved`: shown according to its visibility.
 * Rows written before this field existed read as approved (schema default).
 */
export const PROFILE_REVIEW_STATUSES = ['pending', 'approved'] as const;
export type ProfileReviewStatus = (typeof PROFILE_REVIEW_STATUSES)[number];

/** How a member can be reached (plan §2d item 4). */
export const CONTACT_METHODS = [
  'telegram',
  'signal',
  'email',
  'phone',
  'other',
] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];

@Schema({ _id: false })
export class ContactEntry {
  @Prop({ type: String, enum: CONTACT_METHODS, required: true })
  method: ContactMethod;

  @Prop({ type: String, required: true, trim: true, maxlength: 200 })
  value: string;
}

export const ContactEntrySchema = SchemaFactory.createForClass(ContactEntry);

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

  /**
   * The member uses a nickname rather than their own name (D2; §2b: the
   * migrated Stalemate, James Karma and Novi start this way). Self-declared.
   */
  @Prop({ type: Boolean, default: false })
  anonymous: boolean;

  @Prop({
    type: String,
    enum: PROFILE_REVIEW_STATUSES,
    required: true,
    default: 'approved',
  })
  reviewStatus: ProfileReviewStatus;

  /**
   * Contact rows the member chose to show on their page. Admin-only backup
   * contacts live in `membercontacts`, never here.
   */
  @Prop({ type: [ContactEntrySchema], default: [] })
  contacts: ContactEntry[];

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
