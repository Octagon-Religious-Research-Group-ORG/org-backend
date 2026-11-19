import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  type ContactEntry,
  ContactEntrySchema,
} from '../../social/schemas/social-profile.schema';

/**
 * Who may send a member requests (plan §2d: "connection level I'm open to"):
 * - `nobody`;
 * - `public-members`: only members whose own page is Public;
 * - `any-member`: every approved member.
 */
export const OPEN_TO_VALUES = [
  'nobody',
  'public-members',
  'any-member',
] as const;
export type OpenTo = (typeof OPEN_TO_VALUES)[number];

/** Contact rows a member keeps for their connections only. */
export const MAX_CONNECTION_CONTACT_ROWS = 10;

/**
 * One member's connection settings (Chunk 18). A member with no row, or no
 * `openTo`, gets the default for their page's CURRENT visibility (see
 * `effectiveOpenTo`), so the default follows a later visibility change until
 * the member chooses for themselves.
 *
 * `contacts` are rows shown to connected members only, never on the page;
 * admin-only backup contacts stay in `membercontacts` and are never here.
 * `gateAt` is written by every request a member sends and by every block
 * involving them, so two of those at once are ordered by MongoDB (the same
 * pattern as `userwritegates`).
 */
@Schema({
  collection: 'connectionsettings',
  timestamps: true,
  autoIndex: false,
  autoCreate: false,
})
export class ConnectionSettings {
  /** Clerk user id. */
  @Prop({ type: String, required: true })
  userId: string;

  @Prop({ type: String, enum: OPEN_TO_VALUES })
  openTo?: OpenTo;

  @Prop({ type: [ContactEntrySchema], default: undefined })
  contacts?: ContactEntry[];

  @Prop({ type: Date })
  gateAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export type ConnectionSettingsDocument = HydratedDocument<ConnectionSettings>;
export const ConnectionSettingsSchema =
  SchemaFactory.createForClass(ConnectionSettings);

ConnectionSettingsSchema.index({ userId: 1 }, { unique: true });
