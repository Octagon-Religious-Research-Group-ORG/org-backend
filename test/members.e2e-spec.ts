/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
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
import { MAX_PICTURE_BYTES } from '../src/members/picture-processing';
import { PictureStore } from '../src/members/picture-store.service';
import { OrgSetting } from '../src/members/schemas/org-setting.schema';
import { ModerationLogService } from '../src/moderation/moderation-log.service';
import {
  BlockVersionsService,
  STALE_EDIT_REFUSAL,
} from '../src/social/block-versions.service';
import { BeliefTab } from '../src/social/schemas/belief-tab.schema';
import { BlockVersion } from '../src/social/schemas/block-version.schema';
import { ProfileBlock } from '../src/social/schemas/profile-block.schema';
import { SocialProfile } from '../src/social/schemas/social-profile.schema';

/** A real pipe, real guards where it matters, real access code, fake storage. */
function chain(value: unknown) {
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

const OWNER = 'user_owner';
const versionId = new Types.ObjectId();
const VERSION_ROW = {
  _id: versionId,
  blockId: 'b1',
  seq: 1,
  text: 'Synthetic bio',
  createdAt: new Date('2026-11-01T12:00:00Z'),
  hash: 'f'.repeat(64),
  prevHash: '0'.repeat(64),
  authorUserId: 'user_owner',
};
const appendVersion = jest.fn(
  (): Promise<unknown> => Promise.resolve({ seq: 2 }),
);

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
  findOneAndUpdate: jest.fn(() => chain({ nextTabOrder: 3 })),
};

const pictures = {
  read: jest.fn(() =>
    Promise.resolve({ data: Buffer.from('webp-bytes'), fileId: 'file1' }),
  ),
  livePictures: jest.fn((ids: string[]) => Promise.resolve(new Set(ids))),
  currentPicture: jest.fn((ids: string[]) => Promise.resolve(ids[0])),
  retire: jest.fn(() => Promise.resolve()),
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
    Promise.resolve(req.auth.payload.sub.startsWith('user_admin')),
  ),
  isAdminForRead: jest.fn((req: { auth: { payload: { sub: string } } }) =>
    Promise.resolve(req.auth.payload.sub.startsWith('user_admin')),
  ),
};

function tokenUser(context: ExecutionContext) {
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
              exec: () => Promise.resolve([{ _id: 'b1', seq: 1 }]),
            }),
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

    it('refuses more than one file, by the file limit', async () => {
      const png = Buffer.from('x');
      const { body } = await write('put', '/me/member-page/picture')
        .attach('picture', png, 'a.png')
        .attach('picture', png, 'b.png')
        .expect(400);
      expect(body.message).toMatch(/Too many files/);
    });

    it('refuses an extra form field, by the field limit', async () => {
      pictures.store.mockClear();
      const { body } = await write('put', '/me/member-page/picture')
        .field('note', 'x')
        .attach('picture', Buffer.from('x'), 'a.png')
        .expect(400);
      expect(body.message).toMatch(/Too many fields/);
      expect(pictures.store).not.toHaveBeenCalled();
    });

    it('keeps a signed-in answer out of every cache, and a guest one out of shared caches', async () => {
      const signedIn = await get('/members/chats', 'user_anon').expect(200);
      expect(signedIn.headers['cache-control']).toBe('private, no-store');
      const owner = await write('patch', '/me/member-page/visibility')
        .send({ visibility: 'public' })
        .expect(200);
      expect(owner.headers['cache-control']).toBe('private, no-store');
      const guest = await get('/members/chats').expect(200);
      expect(guest.headers['cache-control']).toBe('no-store');
      expect(guest.headers.vary).toContain('Authorization');
    });

    it('lets a public picture stay cacheable for a signed-in viewer', async () => {
      const { headers } = await get(
        '/members/profiles/open-page/picture',
        'user_anon',
      ).expect(200);
      expect(headers['cache-control']).toBe('public, no-cache');
    });
  });

  describe('editing and history', () => {
    const send = (
      method: 'put' | 'patch' | 'delete',
      path: string,
      user = OWNER,
    ) =>
      request(app.getHttpServer())
        [method](`/api/v1/me/member-page${path}`)
        .set('Authorization', `Bearer ${user}`);

    it.each([
      ['put', '/bio'],
      ['put', '/tabs/tab_1/text'],
      ['put', '/tabs/tab_1/title'],
      ['patch', '/tabs/tab_1/position'],
      ['delete', '/tabs/tab_1'],
    ] as const)('refuses %s %s without a login', async (method, path) => {
      await request(app.getHttpServer())
        [method](`/api/v1/me/member-page${path}`)
        .send({})
        .expect(401);
    });

    it('saves a bio on top of the version the editor saw, stored nowhere', async () => {
      appendVersion.mockClear();
      const { body, headers } = await send('put', '/bio')
        .send({ text: 'A new synthetic bio.', baseSeq: 1 })
        .expect(200);
      expect(body).toEqual({ changed: true, seq: 2 });
      expect(headers['cache-control']).toBe('private, no-store');
      expect(appendVersion).toHaveBeenCalledWith({
        blockId: 'b1',
        text: 'A new synthetic bio.',
        authorUserId: OWNER,
        expectedSeq: 1,
      });
    });

    it('writes nothing for the same text', async () => {
      appendVersion.mockClear();
      await send('put', '/bio')
        .send({ text: ' Synthetic bio \n', baseSeq: 1 })
        .expect(200)
        .expect({ changed: false, seq: 1 });
      expect(appendVersion).not.toHaveBeenCalled();
    });

    it.each([
      ['no starting version', { text: 'x' }],
      ['a negative version', { text: 'x', baseSeq: -1 }],
      ['a fractional version', { text: 'x', baseSeq: 1.5 }],
      ['an empty text', { text: '', baseSeq: 1 }],
      ['an author in the body', { text: 'x', baseSeq: 1, authorUserId: 'u' }],
    ])('refuses an edit with %s', async (_name, body) => {
      await send('put', '/bio').send(body).expect(400);
    });

    it('edits a belief and its title, moves and removes it', async () => {
      await send('put', '/tabs/tab_1/text')
        .send({ text: 'Synthetic belief, edited.', baseSeq: 1 })
        .expect(200);
      await send('put', '/tabs/tab_1/title')
        .send({ title: 'Edited title', baseSeq: 2 })
        .expect(200)
        .expect({ changed: true, seq: 2 });
      await send('patch', '/tabs/tab_1/position')
        .send({ direction: 'sideways' })
        .expect(400);
      await send('delete', '/tabs/tab_1').expect(200).expect({ removed: true });
    });

    it('answers 409 with the plain message when the text moved on', async () => {
      appendVersion.mockRejectedValueOnce(
        new ConflictException(STALE_EDIT_REFUSAL),
      );
      const { body } = await send('put', '/bio')
        .send({ text: 'Another synthetic bio.', baseSeq: 1 })
        .expect(409);
      expect(body.message).toBe(STALE_EDIT_REFUSAL);
    });

    it('refuses an edit from an account with no page', async () => {
      await send('put', '/bio', 'user_nobody')
        .send({ text: 'x', baseSeq: 0 })
        .expect(404);
    });

    it('gives the owner the version to start from, and nobody else', async () => {
      const own = await get('/members/profiles/open-page', OWNER).expect(200);
      expect(own.body.revisions).toEqual({ bio: 1, tabs: {} });
      const guest = await get('/members/profiles/open-page').expect(200);
      expect(guest.body).not.toHaveProperty('revisions');
    });

    it('serves a public page history to a guest, with nothing private in it', async () => {
      const { body, text, headers } = await get(
        '/members/profiles/open-page/bio/history',
      ).expect(200);
      expect(body).toEqual({
        page: 1,
        hasMore: false,
        entries: [
          {
            seq: 1,
            savedAt: '2026-11-01T12:00:00.000Z',
            text: 'Synthetic bio',
            hash: 'ffffffffffff',
            source: 'member',
            wholeText: true,
          },
        ],
      });
      expect(text).not.toMatch(/user_owner|authorUserId|prevHash|LEAKED|_id/);
      expect(headers['cache-control']).toBe('no-store');
      expect(headers.vary).toContain('Authorization');
      const signedIn = await get(
        '/members/profiles/open-page/tabs/tab_1/history?field=title&page=2',
        'user_anon',
      ).expect(200);
      expect(signedIn.headers['cache-control']).toBe('private, no-store');
    });

    it('answers a hidden page history exactly like a missing page', async () => {
      const missing = await get('/members/profiles/no-such-page/bio/history');
      expect(missing.status).toBe(404);
      for (const path of [
        '/members/profiles/hidden-page/bio/history',
        '/members/profiles/hidden-page/tabs/tab_1/history',
        '/members/profiles/waiting-page/bio/history',
        '/members/profiles/named-page/tabs/tab_1/history',
      ]) {
        const { status, body } = await get(path);
        expect(status).toBe(404);
        expect(body).toEqual(missing.body);
      }
    });

    it.each([
      ['a page of zero', '?page=0'],
      ['a page that is not a number', '?page=two'],
      ['an unknown field', '?field=secret'],
      ['an unknown parameter', '?author=1'],
    ])('refuses a history query with %s', async (_n, query) => {
      await get(
        `/members/profiles/open-page/tabs/tab_1/history${query}`,
      ).expect(400);
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

    it('ignores a permission claim on the token', async () => {
      await put('user_named', 'https://t.me/+abc')
        .set('X-Test-Permissions', 'manage:settings')
        .expect(403);
    });

    it('counts against the account ration', async () => {
      const send = (attempt: number) =>
        put('user_admin_ration', 'https://t.me/+abc').set(
          'X-Forwarded-For',
          `203.0.113.${Math.floor(attempt / 8)}`,
        );
      for (let attempt = 0; attempt < 100; attempt++) {
        await send(attempt).expect(200);
      }
      const { body } = await send(100).expect(429);
      expect(body.code).toBe('MEMBER_WRITE_DAILY_LIMIT');
    });

    it('lets an admin set it, audited', async () => {
      moderationLog.record.mockClear();
      await put('user_admin', 'https://t.me/+abc')
        .expect(200)
        .expect({ set: true });
      expect(moderationLog.record).toHaveBeenCalledTimes(2);
    });
  });

  it('applies the write limit to adding a tab', async () => {
    const send = () =>
      request(app.getHttpServer())
        .post('/api/v1/me/member-page/tabs')
        .set('Authorization', 'Bearer user_tablimit')
        .set('X-Forwarded-For', '203.0.113.51')
        .send({ title: 'T', text: 'x' });
    OWN_PAGES.user_tablimit = OWN_PAGES.user_owner;
    for (let attempt = 0; attempt < 10; attempt++) await send().expect(201);
    await send().expect(429);
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
