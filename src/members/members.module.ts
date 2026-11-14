import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminInboxModule } from '../admin-inbox/admin-inbox.module';
import { ModerationModule } from '../moderation/moderation.module';
import {
  ModerationLogEntry,
  ModerationLogEntrySchema,
} from '../moderation/schemas/moderation-log.schema';
import { Report, ReportSchema } from '../moderation/schemas/report.schema';
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
import { Claim, ClaimSchema } from '../social/schemas/claim.schema';
import { SocialModule } from '../social/social.module';
import {
  WebsitePage,
  WebsitePageSchema,
} from '../content/schemas/website-page.schema';
import {
  AdminDashboardController,
  AdminDashboardWritesController,
  MyEamRequestController,
  MyEamRequestWritesController,
} from './admin/admin.controller';
import { AdminLogService } from './admin/admin-log.service';
import { AdminMembersService } from './admin/admin-members.service';
import { AdminRolesService } from './admin/admin-roles.service';
import { EamRequestsService } from './admin/eam-requests.service';
import {
  AdminClaimsController,
  AdminClaimWritesController,
  MyClaimsController,
  MyClaimWritesController,
} from './claims/claims.controller';
import { ClaimRequestThrottleGuard } from './claims/claim-request-throttle.guard';
import { ClaimsService } from './claims/claims.service';
import { LegacyLinksService } from './claims/legacy-links.service';
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
import {
  AdminModerationController,
  AdminModerationWritesController,
  MyReportWritesController,
} from './moderation/moderation.controller';
import { ModerationQueueService } from './moderation/moderation-queue.service';
import { ModerationThrottleGuard } from './moderation/moderation-throttle.guard';
import { ReportsService } from './moderation/reports.service';
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
 * belief votes and the Beliefs page section (Chunk 10), the same votes
 * and comments on ORG's own pages (Chunk 10b), and claims on imported pages
 * with the linking of imported comments (Chunk 11), and the admin dashboard
 * with the "Request EaM" button (Chunk 12), and reports with the moderation
 * queue (Chunk 13).
 */
@Module({
  imports: [
    SocialModule,
    ModerationModule,
    AdminInboxModule,
    MongooseModule.forFeature([
      { name: SocialProfile.name, schema: SocialProfileSchema },
      { name: BeliefTab.name, schema: BeliefTabSchema },
      { name: ProfileBlock.name, schema: ProfileBlockSchema },
      { name: BlockVersion.name, schema: BlockVersionSchema },
      { name: OrgSetting.name, schema: OrgSettingSchema },
      { name: Comment.name, schema: CommentSchema },
      { name: BeliefVote.name, schema: BeliefVoteSchema },
      { name: VoteTally.name, schema: VoteTallySchema },
      { name: Claim.name, schema: ClaimSchema },
      // Read only, for the admin dashboard's log view (Chunk 12).
      { name: ModerationLogEntry.name, schema: ModerationLogEntrySchema },
      // Reports and the moderation queue (Chunk 13).
      { name: Report.name, schema: ReportSchema },
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
    MyClaimsController,
    MyClaimWritesController,
    AdminClaimsController,
    AdminClaimWritesController,
    AdminDashboardController,
    AdminDashboardWritesController,
    MyEamRequestController,
    MyEamRequestWritesController,
    MyReportWritesController,
    AdminModerationController,
    AdminModerationWritesController,
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
    ClaimsService,
    LegacyLinksService,
    ClaimRequestThrottleGuard,
    AdminRolesService,
    AdminMembersService,
    AdminLogService,
    EamRequestsService,
    ReportsService,
    ModerationQueueService,
    ModerationThrottleGuard,
  ],
})
export class MembersModule {}
