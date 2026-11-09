/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
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
import sharp from 'sharp';
import request from 'supertest';
import { App } from 'supertest/types';
import { AdminAccessService } from '../src/auth/admin-access.service';
import { ClerkAuthGuard, OptionalClerkAuthGuard } from '../src/auth/auth.guard';
import { PermissionsGuard } from '../src/auth/permissions.guard';
import { configureHttpApp } from '../src/config/http-app';
import { DEFAULT_THROTTLE } from '../src/config/throttle';
import { MemberWriteThrottleGuard } from '../src/members/member-write-throttle.guard';
import {
  AdminSettingsController,
  MembersController,
  MyMemberPageController,
} from '../src/members/members.controller';
import { MembersService } from '../src/members/members.service';
import { MyMemberPageService } from '../src/members/my-member-page.service';
import { OrgSettingsService } from '../src/members/org-settings.service';
import { MAX_PICTURE_BYTES } from '../src/members/picture-processing';
import { PictureStore } from '../src/members/picture-store.service';
import { OrgSetting } from '../src/members/schemas/org-setting.schema';
import { ModerationLogService } from '../src/moderation/moderation-log.service';
import { BlockVersionsService } from '../src/social/block-versions.service';
import { BeliefTab } from '../src/social/schemas/belief-tab.schema';
import { BlockVersion } from '../src/social/schemas/block-version.schema';
import { ProfileBlock } from '../src/social/schemas/profile-block.schema';
import { SocialProfile } from '../src/social/schemas/social-profile.schema';

/** A real pipe, real guards where it matters, real access code, fake storage. */
function chain(value: unknown) {
  const query = {
    select: () => query,
    sort: () => query,
    limit: () => query,
    lean: () => query,
    exec: () => Promise.resolve(value),
  };
  return query;
}

const OWNER = 'user_owner';
const versionId = new Types.ObjectId();

const page = (slug: string, overrides: Record<string, unknown> = {}) => ({
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

const PAGES = [
  page('open-page'),
  page('members-page', { visibility: 'members', ownerUserId: 'x1' }),
  page('named-page', { visibility: 'named-members', ownerUserId: 'x2' }),
  page('hidden-page', { visibility: 'unlisted' }),
  page('waiting-page', { reviewStatus: 'pending' }),
  page('claim-page', { reviewStatus: 'claiming' }),
  page('gone-page', { deletedAt: new Date(0) }),
];

const OWN_PAGES: Record<string, unknown> = {
  user_owner: {
    _id: new Types.ObjectId(),
    slug: 'open-page',
    imageIds: [],
    reviewStatus: 'approved',
  },
  user_anon: { reviewStatus: 'approved', anonymous: true },
  user_named: { reviewStatus: 'approved', anonymous: false },
};

const profiles = {
  findOne: jest.fn((filter: { slug?: string; ownerUserId?: string }) => {
    if (filter.slug) {
      return chain(PAGES.find((p) => p.slug === filter.slug) ?? null);
    }
    return chain(OWN_PAGES[filter.ownerUserId as string] ?? null);
  }),
  find: jest.fn(() => chain(PAGES)),
  updateOne: jest.fn(() => ({
    exec: () => Promise.resolve({ matchedCount: 1 }),
  })),
};

const pictures = {
  read: jest.fn(() =>
    Promise.resolve({ data: Buffer.from('webp-bytes'), fileId: 'file1' }),
  ),
  roleOf: jest.fn(() => Promise.resolve('picture')),
  store: jest.fn(() => Promise.resolve('new-file')),
  remove: jest.fn(() => Promise.resolve()),
};

const settings = {
  findOne: jest.fn(() => chain({ value: 'https://t.me/+SECRETINVITE' })),
  updateOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  deleteOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
};

const moderationLog = { record: jest.fn(() => Promise.resolve({})) };
const adminAccess = {
  hasAdminAccess: jest.fn((req: { auth: { payload: { sub: string } } }) =>
    Promise.resolve(req.auth.payload.sub === 'user_admin'),
  ),
};

function tokenUser(context: ExecutionContext) {
  const req = context.switchToHttp().getRequest();
  const header: string | undefined = req.headers.authorization;
  if (header) req.auth = { payload: { sub: header.replace('Bearer ', '') } };
  return Boolean(header);
}

const optional: CanActivate = {
  canActivate(context) {
    tokenUser(context);
    return true;
  },
};
const required: CanActivate = {
  canActivate(context) {
    if (!tokenUser(context)) throw new UnauthorizedException();
    return true;
  },
};

describe('Members API (e2e)', () => {
  let app: INestApplication<App>;
  const get = (path: string, user?: string) => {
    const call = request(app.getHttpServer()).get(`/api/v1${path}`);
    return user ? call.set('Authorization', `Bearer ${user}`) : call;
  };

  beforeAll(async () => {
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
        OrgSettingsService,
        MemberWriteThrottleGuard,
        Reflector,
        PermissionsGuard,
        { provide: PictureStore, useValue: pictures },
        { provide: ModerationLogService, useValue: moderationLog },
        { provide: AdminAccessService, useValue: adminAccess },
        {
          provide: BlockVersionsService,
          useValue: { appendVersion: jest.fn(() => Promise.resolve({})) },
        },
        { provide: getModelToken(SocialProfile.name), useValue: profiles },
        {
          provide: getModelToken(BeliefTab.name),
          useValue: {
            find: () => chain([]),
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
          },
        },
        {
          provide: getModelToken(BlockVersion.name),
          useValue: {
            find: () => chain([{ _id: versionId, text: 'Synthetic bio' }]),
          },
        },
        { provide: getModelToken(OrgSetting.name), useValue: settings },
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
    app = nest;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('the directory', () => {
    it('lists only live, listed pages for a guest, and leaks nothing', async () => {
      const { body, text } = await get('/members/directory').expect(200);
      expect(body.members.map((c: { slug: string }) => c.slug).sort()).toEqual([
        'members-page',
        'named-page',
        'open-page',
      ]);
      expect(text).not.toMatch(/LEAKED|user_owner|ownerUserId/);
      const named = body.members.find(
        (c: { slug: string }) => c.slug === 'named-page',
      );
      expect(named).toMatchObject({ access: 'name-only', hasPicture: false });
    });

    it('never lists an unlisted page, even to its owner or an admin', async () => {
      for (const user of [OWNER, 'user_admin']) {
        const { text } = await get('/members/directory', user).expect(200);
        expect(text).not.toContain('hidden-page');
        expect(text).not.toContain('waiting-page');
      }
    });
  });

  describe('a profile', () => {
    it.each(['hidden-page', 'waiting-page', 'claim-page', 'gone-page', 'nope'])(
      'gives a guest the same 404 for %s',
      async (slug) => {
        const missing = await get('/members/profiles/nope').expect(404);
        const { body } = await get(`/members/profiles/${slug}`).expect(404);
        expect(body).toEqual(missing.body);
      },
    );

    it('serves a public page to a logged-out request', async () => {
      const { body, text } = await get('/members/profiles/open-page').expect(
        200,
      );
      expect(body).toMatchObject({ access: 'full', isOwner: false });
      expect(body.bio[0].text).toBe('Synthetic bio');
      expect(text).not.toMatch(/LEAKED|user_owner/);
    });

    it('gives a guest the name of a members page and nothing else', async () => {
      const { body } = await get('/members/profiles/members-page').expect(200);
      expect(Object.keys(body).sort()).toEqual([
        'access',
        'displayName',
        'hasPicture',
        'isOwner',
        'picturePublic',
        'slug',
      ]);
      expect(body.access).toBe('name-only');
    });

    it('opens a members page to an anonymous member', async () => {
      await get('/members/profiles/members-page', 'user_anon')
        .expect(200)
        .expect((res) => expect(res.body.access).toBe('full'));
    });

    it('keeps a named-members page from an anonymous member', async () => {
      await get('/members/profiles/named-page', 'user_anon')
        .expect(200)
        .expect((res) => expect(res.body.access).toBe('name-only'));
    });

    it('shows an owner their pending page, marked as theirs', async () => {
      await get('/members/profiles/waiting-page', OWNER)
        .expect(200)
        .expect((res) =>
          expect(res.body).toMatchObject({
            access: 'full',
            isOwner: true,
            manage: { reviewStatus: 'pending' },
          }),
        );
    });

    it('takes identity only from the token', async () => {
      await get('/members/profiles/hidden-page?userId=user_owner')
        .set('X-User-Id', OWNER)
        .expect(404);
    });
  });

  describe('a picture', () => {
    it('serves a public picture with the right headers', async () => {
      const { headers, body } = await get('/members/profiles/open-page/picture')
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(headers['content-type']).toBe('image/webp');
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['cache-control']).toBe('public, no-cache');
      expect(headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(headers.etag).toBe('"file1"');
      expect(body).toEqual(Buffer.from('webp-bytes'));
    });

    it('answers 304 to a conditional request for a public picture', async () => {
      await get('/members/profiles/open-page/picture')
        .set('If-None-Match', '"file1"')
        .expect(304);
    });

    it.each([
      ['members-page', 'name-only'],
      ['named-page', 'name-only'],
      ['hidden-page', 'none'],
      ['waiting-page', 'none'],
      ['gone-page', 'none'],
    ])('refuses a guest the picture of %s (%s)', async (slug) => {
      pictures.read.mockClear();
      await get(`/members/profiles/${slug}/picture`).expect(404);
      expect(pictures.read).not.toHaveBeenCalled();
    });

    it('never stores a restricted picture anywhere', async () => {
      const { headers } = await get(
        '/members/profiles/members-page/picture',
        'user_named',
      ).expect(200);
      expect(headers['cache-control']).toBe('private, no-store');
      expect(headers.etag).toBeUndefined();
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    });

    it('keeps an owner’s unlisted picture out of every cache', async () => {
      const { headers } = await get(
        '/members/profiles/hidden-page/picture',
        OWNER,
      ).expect(200);
      expect(headers['cache-control']).toBe('private, no-store');
    });
  });

  describe('the chats panel', () => {
    it.each([[undefined], ['user_new']])(
      'hides the invite from %s',
      async (user) => {
        const { text } = await get('/members/chats', user).expect(200);
        expect(text).not.toContain('SECRETINVITE');
        expect(JSON.parse(text)).toEqual({ voting: 'hidden' });
      },
    );

    it('gives the invite to an approved member', async () => {
      await get('/members/chats', 'user_anon')
        .expect(200)
        .expect((res) => expect(res.text).toContain('SECRETINVITE'));
    });
  });

  describe('owner tools', () => {
    const write = (method: 'patch' | 'post' | 'put', path: string) =>
      request(app.getHttpServer())
        [method](`/api/v1${path}`)
        .set('Authorization', `Bearer ${OWNER}`);

    it.each([
      ['patch', '/me/member-page/visibility'],
      ['post', '/me/member-page/tabs'],
      ['put', '/me/member-page/picture'],
      ['put', '/admin/settings/voting-invite'],
    ] as const)('refuses %s %s without a login', async (method, path) => {
      await request(app.getHttpServer())
        [method](`/api/v1${path}`)
        .send({})
        .expect(401);
    });

    it('changes visibility', async () => {
      await write('patch', '/me/member-page/visibility')
        .send({ visibility: 'unlisted' })
        .expect(200)
        .expect({ visibility: 'unlisted' });
    });

    it.each([
      ['an unknown visibility', { visibility: 'friends' }],
      ['an extra field', { visibility: 'public', ownerUserId: 'x' }],
    ])('refuses %s', async (_n, body) => {
      await write('patch', '/me/member-page/visibility').send(body).expect(400);
    });

    it('adds a belief tab, and refuses one with an extra field', async () => {
      await write('post', '/me/member-page/tabs')
        .send({ title: 'God', text: 'One.' })
        .expect(201);
      await write('post', '/me/member-page/tabs')
        .send({ title: 'God', text: 'One.', reviewStatus: 'confirmed' })
        .expect(400);
    });

    it('accepts a real picture and stores the re-encoded form', async () => {
      pictures.store.mockClear();
      const png = await sharp({
        create: { width: 4, height: 4, channels: 3, background: '#123456' },
      })
        .png()
        .toBuffer();
      await write('put', '/me/member-page/picture')
        .attach('picture', png, { filename: 'a.png', contentType: 'image/png' })
        .expect(200)
        .expect({ hasPicture: true });
      expect(pictures.store).toHaveBeenCalledTimes(1);
    });

    it('refuses text that claims to be a picture', async () => {
      pictures.store.mockClear();
      await write('put', '/me/member-page/picture')
        .attach('picture', Buffer.from('<script>alert(1)</script>'), {
          filename: 'a.png',
          contentType: 'image/png',
        })
        .expect(400);
      expect(pictures.store).not.toHaveBeenCalled();
    });

    it('refuses a file over the size limit before reading it', async () => {
      await write('put', '/me/member-page/picture')
        .attach('picture', Buffer.alloc(MAX_PICTURE_BYTES + 1), {
          filename: 'big.png',
          contentType: 'image/png',
        })
        .expect(413);
    });

    it('refuses an upload with no file', async () => {
      await write('put', '/me/member-page/picture').send({}).expect(400);
    });
  });

  describe('the voting invite setting', () => {
    const put = (user: string, inviteUrl: string) =>
      request(app.getHttpServer())
        .put('/api/v1/admin/settings/voting-invite')
        .set('Authorization', `Bearer ${user}`)
        .send({ inviteUrl });

    it('refuses a member who is not an admin', async () => {
      moderationLog.record.mockClear();
      await put('user_named', 'https://t.me/+abc').expect(403);
      expect(moderationLog.record).not.toHaveBeenCalled();
    });

    it('lets an admin set it, audited', async () => {
      moderationLog.record.mockClear();
      await put('user_admin', 'https://t.me/+abc')
        .expect(200)
        .expect({ set: true });
      expect(moderationLog.record).toHaveBeenCalledTimes(2);
    });
  });

  it('applies the write limit to owner tools', async () => {
    const send = () =>
      request(app.getHttpServer())
        .patch('/api/v1/me/member-page/visibility')
        .set('Authorization', 'Bearer user_ratelimit')
        .set('X-Forwarded-For', '203.0.113.50')
        .send({ visibility: 'public' });
    for (let attempt = 0; attempt < 10; attempt++) await send().expect(200);
    await send().expect(429);
  });
});
