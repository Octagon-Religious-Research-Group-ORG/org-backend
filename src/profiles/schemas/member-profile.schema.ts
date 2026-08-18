import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

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
