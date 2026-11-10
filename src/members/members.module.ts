import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ModerationModule } from '../moderation/moderation.module';
import {
  BeliefTab,
  BeliefTabSchema,
} from '../social/schemas/belief-tab.schema';
import {
  BlockVersion,
  BlockVersionSchema,
} from '../social/schemas/block-version.schema';
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
  AdminSettingsController,
  MembersController,
  MyMemberPageController,
} from './members.controller';
import { MemberHistoryService } from './member-history.service';
import { MemberPageEditorService } from './member-page-editor.service';
import { MembersService } from './members.service';
import { MemberWriteThrottleGuard } from './member-write-throttle.guard';
import { MyMemberPageService } from './my-member-page.service';
import { OrgSettingsService } from './org-settings.service';
import { PictureStore } from './picture-store.service';
import { OrgSetting, OrgSettingSchema } from './schemas/org-setting.schema';

/** The directory, member pages, owner tools and the ORG chats panel (Chunk 7). */
@Module({
  imports: [
    SocialModule,
    ModerationModule,
    MongooseModule.forFeature([
      { name: SocialProfile.name, schema: SocialProfileSchema },
      { name: BeliefTab.name, schema: BeliefTabSchema },
      { name: ProfileBlock.name, schema: ProfileBlockSchema },
      { name: BlockVersion.name, schema: BlockVersionSchema },
      { name: OrgSetting.name, schema: OrgSettingSchema },
    ]),
  ],
  controllers: [
    MembersController,
    MyMemberPageController,
    AdminSettingsController,
  ],
  providers: [
    MembersService,
    MyMemberPageService,
    MemberPageEditorService,
    MemberHistoryService,
    OrgSettingsService,
    PictureStore,
    MemberWriteThrottleGuard,
  ],
})
export class MembersModule {}
