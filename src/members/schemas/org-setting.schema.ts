import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export const ORG_SETTING_KEYS = [
  'voting-invite',
  'anonymous-may-vote',
  // Held while an admin role change runs (Chunk 12), so two admins cannot
  // demote each other at once and leave no admin. Not a setting anyone sees.
  'role-change-lock',
] as const;
export type OrgSettingKey = (typeof ORG_SETTING_KEYS)[number];

/**
 * Site settings an admin changes at runtime and that must stay out of the
 * public repository, such as the private ORG Voting invite (plan §2d item 8).
 */
@Schema({
  collection: 'orgsettings',
  timestamps: true,
  autoIndex: false,
  autoCreate: false,
})
export class OrgSetting {
  @Prop({ type: String, enum: ORG_SETTING_KEYS, required: true })
  key: OrgSettingKey;

  @Prop({ type: String, required: true, maxlength: 500 })
  value: string;

  /** Clerk user id of the admin who last changed it. */
  @Prop({ type: String, required: true })
  updatedBy: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export type OrgSettingDocument = HydratedDocument<OrgSetting>;
export const OrgSettingSchema = SchemaFactory.createForClass(OrgSetting);

OrgSettingSchema.index({ key: 1 }, { unique: true });
