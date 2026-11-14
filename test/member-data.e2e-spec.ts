// Data export and page deletion (Chunk 17) over HTTP, with the shared HTTP
// setup (`configureHttpApp`): sign-in on every member route, admins only on
// the admin ones, no-store, the export's rations, and Clerk's webhook
// verified over its RAW bytes through the real body parsers. Services are
// faked; the real-database half is member-data-mongo.e2e-spec.ts.
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Webhook } from 'standardwebhooks';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AdminRoleGuard } from '../src/auth/admin-role.guard';
import { AdminAccessService } from '../src/auth/admin-access.service';
import { ClerkAuthGuard } from '../src/auth/auth.guard';
import { configureHttpApp } from '../src/config/http-app';
import { DEFAULT_THROTTLE } from '../src/config/throttle';
import { ClerkWebhookController } from '../src/member-data/clerk-webhook.controller';
import {
  AdminDeletedPagesController,
  AdminDeletedPageWritesController,
  ExportThrottleGuard,
  MyDataController,
  MyDataWritesController,
} from '../src/member-data/member-data.controller';
import { MemberExportService } from '../src/member-data/member-export.service';
import { MemberPurgeService } from '../src/member-data/member-purge.service';
import { PageDeletionService } from '../src/member-data/page-deletion.service';
import { WebhookEvent } from '../src/member-data/schemas/webhook-event.schema';
import { MemberWriteThrottleGuard } from '../src/members/member-write-throttle.guard';
import { MembersService } from '../src/members/members.service';
import { required } from './members-test-app';

const SECRET = `whsec_${Buffer.from('synthetic-e2e-secret-32-bytes!!!').toString('base64')}`;

describe('member data routes (Chunk 17)', () => {
  let app: INestApplication<App>;
  const deletion = {
    status: jest.fn(() => Promise.resolve({ page: null, disclosure: [] })),
    deleteOwn: jest.fn(() => Promise.resolve({ deleted: true })),
    undoOwn: jest.fn(() => Promise.resolve({ deleted: false })),
    accountDeleted: jest.fn(() => Promise.resolve('deleted')),
    list: jest.fn(() => Promise.resolve({ pages: [], hasMore: false })),
    adminRestore: jest.fn(() => Promise.resolve({ restored: true })),
  };
  const exporter = {
    build: jest.fn(() => Promise.resolve({ zip: new Uint8Array([80, 75]) })),
  };
  const purge = { due: jest.fn(() => Promise.resolve({ pages: [] })) };
  const seen = new Set<string>();
  const events = {
    exists: (filter: { _id: string }) => ({
      exec: () =>
        Promise.resolve(seen.has(filter._id) ? { _id: filter._id } : null),
    }),
    create: (doc: { _id: string }) => {
      seen.add(doc._id);
      return Promise.resolve(doc);
    },
  };
  let secret: string | undefined = SECRET;
  const isAdmin = (req: { auth?: { payload: { sub: string } } }) =>
    Promise.resolve(Boolean(req.auth?.payload.sub.startsWith('user_admin')));

  beforeEach(async () => {
    jest.clearAllMocks();
    secret = SECRET;
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([DEFAULT_THROTTLE])],
      controllers: [
        MyDataController,
        MyDataWritesController,
        AdminDeletedPagesController,
        AdminDeletedPageWritesController,
        ClerkWebhookController,
      ],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        Reflector,
        AdminRoleGuard,
        MemberWriteThrottleGuard,
        ExportThrottleGuard,
        { provide: PageDeletionService, useValue: deletion },
        { provide: MemberExportService, useValue: exporter },
        { provide: MemberPurgeService, useValue: purge },
        { provide: getModelToken(WebhookEvent.name), useValue: events },
        { provide: ConfigService, useValue: { get: () => secret } },
        {
          provide: MembersService,
          useValue: {
            resolveViewer: (req: { auth: { payload: { sub: string } } }) =>
              Promise.resolve({
                kind: 'named-member',
                userId: req.auth.payload.sub,
                isAdmin: false,
              }),
          },
        },
        {
          provide: AdminAccessService,
          useValue: { isAdminForRead: isAdmin, hasAdminAccess: isAdmin },
        },
      ],
    })
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

  afterEach(async () => {
    await app.close();
  });

  const as = (userId: string) => ({ Authorization: `Bearer ${userId}` });

  it('needs a sign-in on every member and admin route', async () => {
    const routes: Array<['get' | 'post', string]> = [
      ['get', '/api/v1/me/data'],
      ['get', '/api/v1/me/data/export'],
      ['post', '/api/v1/me/data/delete-page'],
      ['post', '/api/v1/me/data/undo-delete'],
      ['get', '/api/v1/admin/deleted-pages'],
      ['get', '/api/v1/admin/deleted-pages/purge-due'],
      ['post', '/api/v1/admin/deleted-pages/quiet-fern/restore'],
    ];
    for (const [method, path] of routes) {
      await request(app.getHttpServer())[method](path).send({}).expect(401);
    }
    expect(exporter.build).not.toHaveBeenCalled();
  });

  it('gives a member only their own data, no-store, as a zip named by the day', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/me/data/export')
      .set(as('user_me'))
      .expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="org-my-data-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    expect(exporter.build).toHaveBeenCalledWith(
      'user_me',
      expect.objectContaining({ userId: 'user_me' }),
      expect.any(Date),
    );
    // There is no route that takes someone else's id.
    await request(app.getHttpServer())
      .get('/api/v1/me/data/export?userId=user_other')
      .set(as('user_admin_1'))
      .expect(200);
    expect(exporter.build).toHaveBeenLastCalledWith(
      'user_admin_1',
      expect.anything(),
      expect.any(Date),
    );
  });

  it('rations the export: three a minute per visitor', async () => {
    for (let i = 0; i < 3; i += 1) {
      await request(app.getHttpServer())
        .get('/api/v1/me/data/export')
        .set(as(`user_r${i}`))
        .expect(200);
    }
    await request(app.getHttpServer())
      .get('/api/v1/me/data/export')
      .set(as('user_r9'))
      .expect(429);
  });

  it('deletes and undoes, validating the confirmation', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/me/data/delete-page')
      .set(as('user_me'))
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/me/data/delete-page')
      .set(as('user_me'))
      .send({ confirm: 'quiet-fern', userId: 'user_other' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/me/data/delete-page')
      .set(as('user_me'))
      .send({ confirm: 'quiet-fern' })
      .expect(200, { deleted: true });
    expect(deletion.deleteOwn).toHaveBeenCalledWith('user_me', 'quiet-fern');
    await request(app.getHttpServer())
      .post('/api/v1/me/data/undo-delete')
      .set(as('user_me'))
      .expect(200, { deleted: false });
  });

  it('keeps the admin routes for admins', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/deleted-pages')
      .set(as('user_me'))
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/admin/deleted-pages/purge-due')
      .set(as('user_me'))
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/admin/deleted-pages/quiet-fern/restore')
      .set(as('user_me'))
      .send({ reason: 'x' })
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/admin/deleted-pages?page=2')
      .set(as('user_admin_1'))
      .expect(200);
    expect(deletion.list).toHaveBeenCalledWith(2);
    await request(app.getHttpServer())
      .post('/api/v1/admin/deleted-pages/quiet-fern/restore')
      .set(as('user_admin_1'))
      .send({ reason: 'Asked.' })
      .expect(200);
    expect(deletion.adminRestore).toHaveBeenCalledWith(
      'user_admin_1',
      'quiet-fern',
      'Asked.',
    );
  });

  describe('the Clerk webhook', () => {
    const body = JSON.stringify({
      type: 'user.deleted',
      data: { id: 'user_gone' },
    });
    const signedHeaders = (id: string, payload = body) => ({
      'svix-id': id,
      'svix-timestamp': String(Math.floor(Date.now() / 1000)),
      'svix-signature': new Webhook(SECRET).sign(id, new Date(), payload),
      'content-type': 'application/json',
    });

    it('verifies the exact bytes through the real body parsers, once per id', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/clerk')
        .set(signedHeaders('msg_e2e_1'))
        .send(body)
        .expect(200, { received: true });
      expect(deletion.accountDeleted).toHaveBeenCalledWith('user_gone');
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/clerk')
        .set(signedHeaders('msg_e2e_1'))
        .send(body)
        .expect(200, { received: true, duplicate: true });
      expect(deletion.accountDeleted).toHaveBeenCalledTimes(1);
    });

    it('refuses a body changed after signing, even by whitespace', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/clerk')
        .set(signedHeaders('msg_e2e_2'))
        .send(`${body} `)
        .expect(400);
      expect(deletion.accountDeleted).not.toHaveBeenCalled();
    });

    it('needs no sign-in, and is off with a 503 without its secret', async () => {
      secret = undefined;
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/clerk')
        .set(signedHeaders('msg_e2e_3'))
        .send(body)
        .expect(503);
    });

    it('refuses a body over 64 KB before reading it', async () => {
      const big = JSON.stringify({
        type: 'user.deleted',
        pad: 'x'.repeat(70_000),
      });
      await request(app.getHttpServer())
        .post('/api/v1/webhooks/clerk')
        .set(signedHeaders('msg_e2e_4', big))
        .send(big)
        .expect(413);
    });
  });
});
