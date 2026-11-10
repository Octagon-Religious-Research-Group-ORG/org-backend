import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Who can see a profile (plan D4, §2b D11, §2d), from widest to narrowest:
 * - `public`: everyone, guests and anyone holding the link included;
 * - `members`: every member, anonymous members included;
 * - `named-members`: only members who joined under their own name (owner,
 *   D11: "some members may not want an anonymous member or guest to see
 *   their page");
 * - `unlisted`: the owner's "Private" — never listed in the Members Community,
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
 * - `claiming`: a join in progress holding its owner and address; never shown
 *   to anyone, and removed if the join fails or dies;
 * - `pending`: a new member's page waiting for an admin (the owner's approval
 *   step, plan §2d); shown only to its owner and admins;
 * - `approved`: shown according to its visibility.
 * Rows written before this field existed read as approved (schema default).
 */
export const PROFILE_REVIEW_STATUSES = [
  'claiming',
  'pending',
  'approved',
] as const;
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

export const MAX_DISPLAY_NAME_LENGTH = 120;
export const MAX_CONTACT_VALUE_LENGTH = 200;

@Schema({ _id: false })
export class ContactEntry {
  @Prop({ type: String, enum: CONTACT_METHODS, required: true })
  method: ContactMethod;

  @Prop({
    type: String,
    required: true,
    trim: true,
    maxlength: MAX_CONTACT_VALUE_LENGTH,
  })
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
@Schema({
  collection: 'socialprofiles',
  timestamps: true,
  autoIndex: false,
  autoCreate: false,
})
export class SocialProfile {
  @Prop({
    type: String,
    required: true,
    minlength: 2,
    maxlength: 80,
    match: SLUG_PATTERN,
  })
  slug: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
    maxlength: MAX_DISPLAY_NAME_LENGTH,
  })
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
   * migrated nickname profiles start this way). Self-declared.
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

  /**
   * Addresses of existing pages whose display name reads like this one (same
   * name in another alphabet, or one letter apart). Admins only, for reviewing
   * the page: it does not refuse the name, and no page or member-facing
   * response may include it.
   */
  @Prop({ type: [String], default: [] })
  similarNameOf: string[];

  /**
   * Belief tabs on this page that are not removed, counted so a new tab can
   * take a place atomically. Absent on pages made by the import or the join
   * form until their first new tab sets it from the real rows. Whatever
   * removes a tab must take one off this.
   */
  @Prop({ type: Number, min: 0 })
  liveTabCount?: number;

  /** When a tab place was last taken: a recount must wait for adds to finish. */
  @Prop({ type: Date })
  lastTabPlaceAt?: Date;

  /** Counter corrections so far: a place taken before one is no longer counted. */
  @Prop({ type: Number, min: 0 })
  tabCountRepairs?: number;

  /** The next tab's `order`. Only ever rises, so an order is never reused. */
  @Prop({ type: Number, min: 0 })
  nextTabOrder?: number;

  /**
   * Tab removals that have taken their turn but not finished (Chunk 8). A
   * removal is counted off `liveTabCount` only after its tab is really gone,
   * so a removal that dies part-way leaves the counter too high, never too
   * low. A turn left behind by such a removal is cleared after a while.
   */
  @Prop({ type: Number, min: 0 })
  pendingRemovals?: number;

  /** When a removal last took its turn: an old pending turn is a dead one. */
  @Prop({ type: Date })
  lastRemovalTurnAt?: Date;

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
