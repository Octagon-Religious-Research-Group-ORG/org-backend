/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
// The members API under test, shared by the members e2e specs: a real pipe,
// real guards where it matters, real access code, fake storage. Each spec file
// gets its own module instance, so its fakes and rate limits are its own.
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Types } from 'mongoose';
import { App } from 'supertest/types';
import { AdminAccessService } from '../src/auth/admin-access.service';
import { ClerkAuthGuard, OptionalClerkAuthGuard } from '../src/auth/auth.guard';
import { AdminRoleGuard } from '../src/auth/admin-role.guard';
import { configureHttpApp } from '../src/config/http-app';
import { DEFAULT_THROTTLE } from '../src/config/throttle';
import { MemberWriteThrottleGuard } from '../src/members/member-write-throttle.guard';
import {
  AdminSettingsController,
  MembersController,
  MyMemberPageController,
} from '../src/members/members.controller';
import { MemberHistoryService } from '../src/members/member-history.service';
import { MemberPageEditorService } from '../src/members/member-page-editor.service';
import { MembersService } from '../src/members/members.service';
import { MyMemberPageService } from '../src/members/my-member-page.service';
import { OrgSettingsService } from '../src/members/org-settings.service';
import { PictureStore } from '../src/members/picture-store.service';
import { VoteTalliesService } from '../src/members/votes/vote-tallies.service';
import { VotesService } from '../src/members/votes/votes.service';
import { OrgSetting } from '../src/members/schemas/org-setting.schema';
import { ModerationLogService } from '../src/moderation/moderation-log.service';
import { BlockVersionsService } from '../src/social/block-versions.service';
import { BeliefTab } from '../src/social/schemas/belief-tab.schema';
import { BlockVersion } from '../src/social/schemas/block-version.schema';
import { Comment } from '../src/social/schemas/comment.schema';
import { CommentAuthorsService } from '../src/members/comments/comment-authors.service';
import { ProfileBlock } from '../src/social/schemas/profile-block.schema';
import { SocialProfile } from '../src/social/schemas/social-profile.schema';

/** A real pipe, real guards where it matters, real access code, fake storage. */
export function chain(value: unknown) {
  const query = {
    select: () => query,
    sort: () => query,
    skip: () => query,
    limit: () => query,
    lean: () => query,
    exec: () => Promise.resolve(value),
  };
  return query;
}

export const OWNER = 'user_owner';
export const versionId = new Types.ObjectId();
export const VERSION_ROW = {
  _id: versionId,
  blockId: 'b1',
  seq: 1,
  text: 'Synthetic bio',
  createdAt: new Date('2026-11-01T12:00:00Z'),
  hash: 'f'.repeat(64),
  prevHash: '0'.repeat(64),
  authorUserId: 'user_owner',
};
export const appendVersion = jest.fn(
  (): Promise<unknown> => Promise.resolve({ seq: 2 }),
);

export const page = (
  slug: string,
  overrides: Record<string, unknown> = {},
) => ({
  _id: new Types.ObjectId(),
  slug,
  displayName: `Name of ${slug}`,
  visibility: 'public',
  reviewStatus: 'approved',
  ownerUserId: OWNER,
  imageIds: ['507f1f77bcf86cd799439011'],
  contacts: [],
  similarNameOf: ['LEAKED'],
  legacy: { pagesUrl: 'LEAKED' },
  ...overrides,
});

export const PAGES = [
  page('open-page'),
  page('members-page', { visibility: 'members', ownerUserId: 'x1' }),
  page('named-page', { visibility: 'named-members', ownerUserId: 'x2' }),
  page('hidden-page', { visibility: 'unlisted' }),
  page('waiting-page', { reviewStatus: 'pending' }),
  page('claim-page', { reviewStatus: 'claiming' }),
  page('gone-page', { deletedAt: new Date(0) }),
];

export const OWN_PAGES: Record<string, unknown> = {
  user_owner: {
    _id: new Types.ObjectId(),
    slug: 'open-page',
    imageIds: [],
    reviewStatus: 'approved',
  },
  user_anon: { reviewStatus: 'approved', anonymous: true },
  user_named: { reviewStatus: 'approved', anonymous: false },
};

export const profiles = {
  findOne: jest.fn((filter: { slug?: string; ownerUserId?: string }) => {
    if (filter.slug) {
      return chain(PAGES.find((p) => p.slug === filter.slug) ?? null);
    }
    return chain(OWN_PAGES[filter.ownerUserId as string] ?? null);
  }),
  // By owner, one page each, as an account has at most one (Chunk 16 round
  // 2: who may know a version's author is read from the owner's page).
  find: jest.fn((filter?: { ownerUserId?: { $in?: string[] } }) => {
    const owners = filter?.ownerUserId?.$in;
    if (!owners) return chain(PAGES);
    return chain(
      PAGES.filter(
        (p, i) =>
          owners.includes(p.ownerUserId) &&
          PAGES.findIndex((q) => q.ownerUserId === p.ownerUserId) === i,
      ),
    );
  }),
  updateOne: jest.fn(() => ({
    exec: () => Promise.resolve({ matchedCount: 1, modifiedCount: 1 }),
  })),
  findOneAndUpdate: jest.fn(() => chain({ nextTabOrder: 3 })),
};

export const pictures = {
  read: jest.fn(() =>
    Promise.resolve({ data: Buffer.from('webp-bytes'), fileId: 'file1' }),
  ),
  livePictures: jest.fn((ids: string[]) => Promise.resolve(new Set(ids))),
  currentPicture: jest.fn((ids: string[]) => Promise.resolve(ids[0])),
  retire: jest.fn(() => Promise.resolve()),
  store: jest.fn(() => Promise.resolve('new-file')),
  remove: jest.fn(() => Promise.resolve()),
};

export const settings = {
  findOne: jest.fn(() => chain({ value: 'https://t.me/+SECRETINVITE' })),
  updateOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  deleteOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
};

export const moderationLog = { record: jest.fn(() => Promise.resolve({})) };
export const adminAccess = {
  hasAdminAccess: jest.fn((req: { auth: { payload: { sub: string } } }) =>
    Promise.resolve(req.auth.payload.sub.startsWith('user_admin')),
  ),
  isAdminForRead: jest.fn((req: { auth: { payload: { sub: string } } }) =>
    Promise.resolve(req.auth.payload.sub.startsWith('user_admin')),
  ),
};

export function tokenUser(context: ExecutionContext) {
  const req = context.switchToHttp().getRequest();
  const header: string | undefined = req.headers.authorization;
  if (header) {
    req.auth = {
      payload: {
        sub: header.replace('Bearer ', ''),
        permissions: req.headers['x-test-permissions']?.split(','),
      },
    };
  }
  return Boolean(header);
}

export const optional: CanActivate = {
  canActivate(context) {
    tokenUser(context);
    return true;
  },
};
export const required: CanActivate = {
  canActivate(context) {
    if (!tokenUser(context)) throw new UnauthorizedException();
    return true;
  },
};

/** Builds the app every members e2e spec runs against. */
export async function createMembersApp(): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([DEFAULT_THROTTLE])],
    controllers: [
      MembersController,
      MyMemberPageController,
      AdminSettingsController,
    ],
    providers: [
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      MembersService,
      MyMemberPageService,
      MemberPageEditorService,
      MemberHistoryService,
      OrgSettingsService,
      MemberWriteThrottleGuard,
      Reflector,
      AdminRoleGuard,
      { provide: PictureStore, useValue: pictures },
      { provide: ModerationLogService, useValue: moderationLog },
      { provide: AdminAccessService, useValue: adminAccess },
      {
        provide: BlockVersionsService,
        useValue: { appendVersion },
      },
      { provide: getModelToken(SocialProfile.name), useValue: profiles },
      {
        provide: getModelToken(BeliefTab.name),
        useValue: {
          find: () => chain([]),
          findOne: () =>
            chain({ tabId: 'tab_1', title: 'Synthetic title', order: 0 }),
          countDocuments: () => ({ exec: () => Promise.resolve(2) }),
          updateOne: () => ({
            exec: () => Promise.resolve({ modifiedCount: 1 }),
          }),
          create: jest.fn(() => Promise.resolve({})),
        },
      },
      {
        provide: getModelToken(ProfileBlock.name),
        useValue: {
          find: () =>
            chain([
              {
                blockId: 'b1',
                section: 'bio',
                kind: 'paragraph',
                currentVersionId: versionId,
              },
            ]),
          create: jest.fn(() => Promise.resolve({})),
          updateOne: () => ({ exec: () => Promise.resolve({}) }),
          updateMany: () => ({ exec: () => Promise.resolve({}) }),
        },
      },
      {
        provide: getModelToken(BlockVersion.name),
        useValue: {
          find: () => chain([VERSION_ROW]),
          aggregate: () => ({
            exec: () =>
              Promise.resolve([{ _id: 'b1', seq: 1, text: 'Synthetic bio' }]),
          }),
        },
      },
      { provide: getModelToken(OrgSetting.name), useValue: settings },
      // Comments (Chunk 9) have their own e2e app; here every page has none.
      {
        provide: getModelToken(Comment.name),
        useValue: {
          find: () => chain([]),
          aggregate: () => ({ exec: () => Promise.resolve([]) }),
        },
      },
      CommentAuthorsService,
      // Votes (Chunk 10) have their own e2e app; here profiles pass through
      // and edits touch no tally.
      {
        provide: VotesService,
        useValue: { withVotes: (view: unknown) => Promise.resolve(view) },
      },
      {
        provide: VoteTalliesService,
        useValue: {
          touch: () => Promise.resolve(),
          settle: () => Promise.resolve(),
        },
      },
    ],
  })
    .overrideGuard(OptionalClerkAuthGuard)
    .useValue(optional)
    .overrideGuard(ClerkAuthGuard)
    .useValue(required)
    .compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>();
  configureHttpApp(nest, {
    origins: ['http://localhost'],
    trustProxyHops: 1,
  });
  await nest.init();
  return nest;
}
