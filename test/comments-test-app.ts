// The comments API under test (Chunk 9): real controllers, pipe, guards,
// throttles, access code and services, over in-memory models that honour the
// filters (`fake-model`). Only Clerk and the database are stand-ins.
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { App } from 'supertest/types';
import { AdminAccessService } from '../src/auth/admin-access.service';
import { ClerkAuthGuard, OptionalClerkAuthGuard } from '../src/auth/auth.guard';
import { ClerkUserInfoService } from '../src/auth/clerk-user-info.service';
import { configureHttpApp } from '../src/config/http-app';
import { DEFAULT_THROTTLE } from '../src/config/throttle';
import { CommentAuthorsService } from '../src/members/comments/comment-authors.service';
import { CommentWritersService } from '../src/members/comments/comment-writers';
import {
  CommentThreadsController,
  CommentWritesController,
} from '../src/members/comments/comments.controller';
import { CommentsService } from '../src/members/comments/comments.service';
import { SuggestionsService } from '../src/members/comments/suggestions.service';
import {
  seedBlocks,
  seedImportedComments,
  seedProfiles,
  seedTabs,
} from '../src/members/comments/comments-harness.mocks-spec';
import { MemberHistoryService } from '../src/members/member-history.service';
import { MemberPageEditorService } from '../src/members/member-page-editor.service';
import { MemberWriteThrottleGuard } from '../src/members/member-write-throttle.guard';
import {
  MembersController,
  MyMemberPageController,
} from '../src/members/members.controller';
import { MembersService } from '../src/members/members.service';
import { MyMemberPageService } from '../src/members/my-member-page.service';
import { OrgSettingsService } from '../src/members/org-settings.service';
import { PictureStore } from '../src/members/picture-store.service';
import { ModerationLogService } from '../src/moderation/moderation-log.service';
import { BlockVersionsService } from '../src/social/block-versions.service';
import { CommentVersionsService } from '../src/social/comment-versions.service';
import { BeliefTab } from '../src/social/schemas/belief-tab.schema';
import { BlockVersion } from '../src/social/schemas/block-version.schema';
import { CommentVersion } from '../src/social/schemas/comment-version.schema';
import { Comment } from '../src/social/schemas/comment.schema';
import { ProfileBlock } from '../src/social/schemas/profile-block.schema';
import { SocialProfile } from '../src/social/schemas/social-profile.schema';
import {
  type FakeModel,
  fakeModel,
} from '../src/test-support/fake-model.mocks-spec';
import { optional, required } from './members-test-app';

export interface CommentsApp {
  app: INestApplication<App>;
  models: Record<
    | 'profiles'
    | 'tabs'
    | 'blocks'
    | 'versions'
    | 'comments'
    | 'commentVersions',
    FakeModel
  >;
}

/** Fresh data for every app, so one spec's writes never reach another. */
export async function createCommentsApp(): Promise<CommentsApp> {
  const seeded = seedBlocks();
  const models = {
    profiles: fakeModel(seedProfiles()),
    tabs: fakeModel(seedTabs(), { timestamps: true }),
    blocks: fakeModel(
      seeded.map((s) => s.block),
      { unique: [['blockId']], timestamps: true },
    ),
    versions: fakeModel(
      seeded.map((s) => s.version),
      { unique: [['blockId', 'seq']] },
    ),
    comments: fakeModel(seedImportedComments(), {
      unique: [['commentId']],
      timestamps: true,
    }),
    commentVersions: fakeModel([], { unique: [['commentId', 'seq']] }),
  };
  const isAdmin = (req: { auth: { payload: { sub: string } } }) =>
    Promise.resolve(req.auth.payload.sub.startsWith('user_admin'));
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([DEFAULT_THROTTLE])],
    controllers: [
      MembersController,
      MyMemberPageController,
      CommentThreadsController,
      CommentWritesController,
    ],
    providers: [
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      Reflector,
      MembersService,
      MyMemberPageService,
      MemberPageEditorService,
      MemberHistoryService,
      MemberWriteThrottleGuard,
      CommentsService,
      SuggestionsService,
      CommentAuthorsService,
      CommentWritersService,
      BlockVersionsService,
      CommentVersionsService,
      {
        provide: AdminAccessService,
        useValue: { isAdminForRead: isAdmin, hasAdminAccess: isAdmin },
      },
      {
        provide: ClerkUserInfoService,
        useValue: {
          getIdentity: (userId: string) =>
            Promise.resolve(
              userId.includes('unverified')
                ? { email: 'x@example.test', emailVerified: false }
                : { email: `${userId}@example.test`, emailVerified: true },
            ),
        },
      },
      {
        provide: PictureStore,
        useValue: { currentPicture: () => Promise.resolve(undefined) },
      },
      { provide: OrgSettingsService, useValue: {} },
      { provide: ModerationLogService, useValue: {} },
      { provide: getModelToken(SocialProfile.name), useValue: models.profiles },
      { provide: getModelToken(BeliefTab.name), useValue: models.tabs },
      { provide: getModelToken(ProfileBlock.name), useValue: models.blocks },
      { provide: getModelToken(BlockVersion.name), useValue: models.versions },
      { provide: getModelToken(Comment.name), useValue: models.comments },
      {
        provide: getModelToken(CommentVersion.name),
        useValue: models.commentVersions,
      },
    ],
  })
    .overrideGuard(OptionalClerkAuthGuard)
    .useValue(optional)
    .overrideGuard(ClerkAuthGuard)
    .useValue(required)
    .compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>();
  configureHttpApp(nest, { origins: ['http://localhost'], trustProxyHops: 1 });
  await nest.init();
  return { app: nest, models };
}
