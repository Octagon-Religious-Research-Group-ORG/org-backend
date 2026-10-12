import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  type ContactEntry,
  ContactEntrySchema,
} from '../../social/schemas/social-profile.schema';

/**
 * Backup ways to reach a member, visible to the member and admins only (plan
 * §2d item 4: Tripp asks every member for at least two, in case one line is
 * lost). Kept out of `socialprofiles` on purpose, so no page serializer can
 * ever leak them.
 */
@Schema({ collection: 'membercontacts', timestamps: true, autoIndex: false })
export class MemberContacts {
  @Prop({ type: String, required: true })
  userId: string;

  @Prop({ type: [ContactEntrySchema], default: [] })
  backup: ContactEntry[];

  createdAt?: Date;
  updatedAt?: Date;
}

export type MemberContactsDocument = HydratedDocument<MemberContacts>;
export const MemberContactsSchema =
  SchemaFactory.createForClass(MemberContacts);

MemberContactsSchema.index({ userId: 1 }, { unique: true });
