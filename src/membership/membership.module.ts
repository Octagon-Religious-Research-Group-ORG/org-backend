import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  BeliefTab,
  BeliefTabSchema,
} from '../social/schemas/belief-tab.schema';
import {
  ProfileBlock,
  ProfileBlockSchema,
} from '../social/schemas/profile-block.schema';
import {
  SocialProfile,
  SocialProfileSchema,
} from '../social/schemas/social-profile.schema';
import { SocialModule } from '../social/social.module';
import {
  MembershipController,
  MyMembershipController,
} from './membership.controller';
import { MembershipService } from './membership.service';
import {
  ConsentRecord,
  ConsentRecordSchema,
} from './schemas/consent-record.schema';
import {
  MemberContacts,
  MemberContactsSchema,
} from './schemas/member-contacts.schema';
import { VisitRecord, VisitRecordSchema } from './schemas/visit-record.schema';

/** Entry to the Members Community: terms, guests, and joining (Chunk 6). */
@Module({
  imports: [
    SocialModule,
    MongooseModule.forFeature([
      { name: SocialProfile.name, schema: SocialProfileSchema },
      { name: BeliefTab.name, schema: BeliefTabSchema },
      { name: ProfileBlock.name, schema: ProfileBlockSchema },
      { name: ConsentRecord.name, schema: ConsentRecordSchema },
      { name: MemberContacts.name, schema: MemberContactsSchema },
      { name: VisitRecord.name, schema: VisitRecordSchema },
    ]),
  ],
  controllers: [MembershipController, MyMembershipController],
  providers: [MembershipService],
})
export class MembershipModule {}
