import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { MEMBER_ROLES, type MemberRole } from '../../auth/roles';

export type MembershipType = 'public' | 'private' | 'anonymous';
export type ContactMethod = 'email' | 'signal' | 'telegram';

@Schema({ _id: false })
export class ShippingAddress {
  @Prop({ type: String, required: true })
  recipientName: string;

  @Prop({ type: String, required: true })
  line1: string;

  @Prop({ type: String })
  line2?: string;

  @Prop({ type: String, required: true })
  city: string;

  @Prop({ type: String, required: true })
  state: string;

  @Prop({ type: String, required: true })
  postalCode: string;

  @Prop({ type: String, default: 'US' })
  country: 'US';

  @Prop({ type: String })
  phone?: string;
}

export const ShippingAddressSchema =
  SchemaFactory.createForClass(ShippingAddress);

@Schema({ timestamps: true })
export class MemberProfile {
  @Prop({ type: String, required: true, unique: true, index: true })
  authProviderId: string;

  @Prop({ type: String, trim: true, lowercase: true, index: true })
  authEmail?: string;

  @Prop({ type: Boolean, default: false })
  authEmailVerified: boolean;

  @Prop({ type: String })
  authEmailTokenHash?: string;

  @Prop({ type: Boolean, default: false })
  isAdmin: boolean;

  /** Clerk role cached at the last sync (see AdminAccessService). */
  @Prop({ type: String, enum: MEMBER_ROLES })
  authRole?: MemberRole;

  /** When `authRole` was last read from Clerk; bounds how long it is trusted. */
  @Prop({ type: Date })
  authRoleCheckedAt?: Date;

  /**
   * When this account last lost a role (Chunk 12): a role cached from a
   * Clerk read that began earlier is never trusted again.
   */
  @Prop({ type: Date })
  roleRevokedAt?: Date;

  @Prop({ type: String, default: '' })
  preferredName: string;

  @Prop({ type: String, default: '' })
  email: string;

  @Prop({ type: String, default: 'private' })
  membershipType: MembershipType;

  @Prop({ type: String, default: 'email' })
  contactMethod: ContactMethod;

  @Prop({ type: String, default: '' })
  contactHandle: string;

  @Prop({ type: String, default: '' })
  beliefsSummary: string;

  @Prop({ type: ShippingAddressSchema })
  shippingAddress?: ShippingAddress;

  createdAt?: Date;
  updatedAt?: Date;
}

export type MemberProfileDocument = HydratedDocument<MemberProfile>;
export const MemberProfileSchema = SchemaFactory.createForClass(MemberProfile);
