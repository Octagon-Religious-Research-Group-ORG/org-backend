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
import { Comment, CommentSchema } from '../social/schemas/comment.schema';
import {
  BeliefVote,
  BeliefVoteSchema,
} from '../social/schemas/belief-vote.schema';
import {
  VoteTally,
  VoteTallySchema,
} from '../social/schemas/vote-tally.schema';
import { SocialModule } from '../social/social.module';
import {
  WebsitePage,
  WebsitePageSchema,
} from '../content/schemas/website-page.schema';
import { CommentAuthorsService } from './comments/comment-authors.service';
import { CommentStore } from './comments/comment-store';
import { CommentWritersService } from './comments/comment-writers';
import {
  CommentThreadsController,
  CommentWritesController,
} from './comments/comments.controller';
import { CommentsService } from './comments/comments.service';
import { SuggestionsService } from './comments/suggestions.service';
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
import {
  OrgPageReactionsController,
  OrgPageReactionWritesController,
} from './org-pages/org-pages.controller';
import { OrgPagesService } from './org-pages/org-pages.service';
import { PictureStore } from './picture-store.service';
import { OrgSetting, OrgSettingSchema } from './schemas/org-setting.schema';
import {
  AgreedBeliefsController,
  VoteWritesController,
} from './votes/votes.controller';
import { VotersService } from './votes/voters.service';
import { VoteTalliesService } from './votes/vote-tallies.service';
import { VotesService } from './votes/votes.service';

/**
 * The directory, member pages, owner tools and the ORG chats panel (Chunk 7),
 * editing and history (Chunk 8), comments and rewording suggestions (Chunk 9),
 * belief votes and the Beliefs page section (Chunk 10), and the same votes
 * and comments on ORG's own pages (Chunk 10b).
 */
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
      { name: Comment.name, schema: CommentSchema },
      { name: BeliefVote.name, schema: BeliefVoteSchema },
      { name: VoteTally.name, schema: VoteTallySchema },
      // Read only, for votes and comments on ORG's own pages (Chunk 10b).
      { name: WebsitePage.name, schema: WebsitePageSchema },
    ]),
  ],
  controllers: [
    MembersController,
    MyMemberPageController,
    AdminSettingsController,
    CommentThreadsController,
    CommentWritesController,
    AgreedBeliefsController,
    VoteWritesController,
    OrgPageReactionsController,
    OrgPageReactionWritesController,
  ],
  providers: [
    MembersService,
    MyMemberPageService,
    MemberPageEditorService,
    MemberHistoryService,
    OrgSettingsService,
    PictureStore,
    MemberWriteThrottleGuard,
    CommentsService,
    CommentStore,
    SuggestionsService,
    CommentAuthorsService,
    CommentWritersService,
    VotesService,
    VotersService,
    VoteTalliesService,
    OrgPagesService,
  ],
})
export class MembersModule {}
