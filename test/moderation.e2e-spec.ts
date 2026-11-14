// The report button and the moderation queue routes (Chunk 13) through the
// real controllers, validation pipe, guards and throttles, with the services
// stubbed: who may reach which route, what a request may carry, and that
// nothing is cached. What the services do against a real database is in
// moderation-mongo.e2e-spec.ts. Synthetic data only.
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AdminAccessService } from '../src/auth/admin-access.service';
import { AdminRoleGuard } from '../src/auth/admin-role.guard';
import { ClerkAuthGuard } from '../src/auth/auth.guard';
import { configureHttpApp } from '../src/config/http-app';
import {
  DEFAULT_THROTTLE,
  MEMBER_WRITE_ACCOUNT_THROTTLE,
  WRITE_THROTTLE,
} from '../src/config/throttle';
import { CommentWritersService } from '../src/members/comments/comment-writers';
import { MemberWriteThrottleGuard } from '../src/members/member-write-throttle.guard';
import { ModerationThrottleGuard } from '../src/members/moderation/moderation-throttle.guard';
import {
  AdminModerationController,
  AdminModerationWritesController,
  MyReportWritesController,
} from '../src/members/moderation/moderation.controller';
import { ModerationQueueService } from '../src/members/moderation/moderation-queue.service';
import { ReportsService } from '../src/members/moderation/reports.service';
import { required } from './members-test-app';

const PAGE = '0123456789abcdef01234567';

describe('moderation API (e2e)', () => {
  let app: INestApplication<App>;
  let address = 0;
  const ok = (value: unknown) => jest.fn(() => Promise.resolve(value));
  const queue = {
    queue: ok({ entries: [], hasMore: false }),
    moderateComment: ok({ moderation: 'hidden', reportsClosed: 0 }),
    dismiss: ok({ dismissed: 1 }),
  };
  const reports = { report: ok({ reported: true }) };
  const writers = {
    requireWriter: jest.fn((req: { auth: { payload: { sub: string } } }) =>
      Promise.resolve({
        kind: 'named-member',
        userId: req.auth.payload.sub,
        isAdmin: false,
        writesAsAdmin: false,
      }),
    ),
  };
  const isAdmin = (req: { auth: { payload: { sub: string } } }) =>
    Promise.resolve(req.auth.payload.sub.startsWith('user_admin'));
  const call = (method: 'get' | 'post', path: string, user?: string) => {
    address++;
    const req = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('Origin', 'http://localhost')
      .set('X-Forwarded-For', `198.51.100.${address % 250}`);
    return user ? req.set('Authorization', `Bearer ${user}`) : req;
  };

  const ADMIN_ROUTES = [
    ['get', '/admin/moderation/queue', undefined],
    ['post', '/admin/moderation/comments/cmt_1/hide', { reason: 'r' }],
    ['post', '/admin/moderation/comments/cmt_1/remove', { reason: 'r' }],
    ['post', '/admin/moderation/comments/cmt_1/restore', { reason: 'r' }],
    ['post', '/admin/moderation/comment/cmt_1/dismiss', { reason: 'r' }],
    ['post', `/admin/moderation/member-page/${PAGE}/dismiss`, { reason: 'r' }],
  ] as const;
  const REPORT = { targetType: 'comment', commentId: 'cmt_1', reason: 'spam' };

  const serviceCalls = () =>
    [queue, reports]
      .flatMap((service) => Object.values(service))
      .reduce((sum, fn) => sum + fn.mock.calls.length, 0);

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([DEFAULT_THROTTLE])],
      controllers: [
        MyReportWritesController,
        AdminModerationController,
        AdminModerationWritesController,
      ],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        Reflector,
        AdminRoleGuard,
        MemberWriteThrottleGuard,
        ModerationThrottleGuard,
        { provide: ModerationQueueService, useValue: queue },
        { provide: ReportsService, useValue: reports },
        { provide: CommentWritersService, useValue: writers },
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

  it('needs a sign-in on every route, reporting included', async () => {
    for (const [method, path, body] of ADMIN_ROUTES) {
      await call(method, path)
        .send(body ?? {})
        .expect(401);
    }
    await call('post', '/me/reports').send(REPORT).expect(401);
    expect(serviceCalls()).toBe(0);
    expect(writers.requireWriter).not.toHaveBeenCalled();
  });

  it('shows a member who is not an admin no report and lets them act on none', async () => {
    for (const [method, path, body] of ADMIN_ROUTES) {
      await call(method, path, 'user_member')
        .send(body ?? {})
        .expect(403);
    }
    expect(serviceCalls()).toBe(0);
  });

  it('answers admins, stored by no cache', async () => {
    for (const [method, path, body] of ADMIN_ROUTES) {
      const response = await call(method, path, 'user_admin').send(body ?? {});
      expect([path, response.status]).toEqual([
        path,
        method === 'get' ? 200 : 201,
      ]);
      expect(response.headers['cache-control']).toBe('private, no-store');
    }
    expect(queue.queue).toHaveBeenCalledWith('user_admin', 'open', 1);
    expect(queue.moderateComment).toHaveBeenCalledWith(
      'user_admin',
      'cmt_1',
      'hide',
      'r',
    );
    expect(queue.dismiss).toHaveBeenCalledWith(
      'user_admin',
      'member-page',
      PAGE,
      'r',
    );
  });

  it('takes a member’s report, says nothing more, and stores nothing in a cache', async () => {
    const response = await call('post', '/me/reports', 'user_member')
      .send({ ...REPORT, note: 'Synthetic note.' })
      .expect(201);
    expect(response.body).toEqual({ reported: true });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(reports.report).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_member' }),
      { ...REPORT, note: 'Synthetic note.' },
    );
  });

  it('accepts only the fields and values each route may carry', async () => {
    const bad: Array<['get' | 'post', string, object?]> = [
      ['get', '/admin/moderation/queue?status=deleted'],
      ['get', '/admin/moderation/queue?page=0'],
      ['post', '/admin/moderation/comments/cmt_1/hide', {}],
      [
        'post',
        '/admin/moderation/comments/cmt_1/hide',
        { reason: 'x'.repeat(1501) },
      ],
      ['post', '/admin/moderation/comment/cmt_1/dismiss', {}],
    ];
    for (const [method, path, body] of bad) {
      const response = await call(method, path, 'user_admin').send(body ?? {});
      expect([path, response.status]).toEqual([path, 400]);
    }
    const badReports = [
      { ...REPORT, reason: 'boring' },
      { ...REPORT, targetType: 'belief' },
      { ...REPORT, commentId: 'bad id!' },
      { ...REPORT, note: 'x'.repeat(3001) },
      { ...REPORT, reporterUserId: 'user_someone_else' },
      { targetType: 'member-page', slug: 'bad slug', reason: 'spam' },
    ];
    for (const body of badReports) {
      const response = await call('post', '/me/reports', 'user_member').send(
        body,
      );
      expect([body, response.status]).toEqual([body, 400]);
    }
    // Malformed ids are "no such thing", never a lookup.
    for (const path of [
      '/admin/moderation/comments/bad%20id/hide',
      '/admin/moderation/claim/cmt_1/dismiss',
      '/admin/moderation/member-page/cmt_1/dismiss',
    ]) {
      await call('post', path, 'user_admin').send({ reason: 'r' }).expect(404);
    }
    expect(serviceCalls()).toBe(0);
  });

  it('rations moderation on its own daily cap, not the member-write one (review L-5)', async () => {
    for (let n = 0; n <= MEMBER_WRITE_ACCOUNT_THROTTLE.limit; n++) {
      // A new address each time, so only the per-account ration counts.
      await call('post', '/admin/moderation/comments/cmt_1/hide', 'user_admin')
        .send({ reason: 'r' })
        .expect(201);
    }
    expect(queue.moderateComment).toHaveBeenCalledTimes(
      MEMBER_WRITE_ACCOUNT_THROTTLE.limit + 1,
    );
  });

  it('limits reports per visitor like every member write', async () => {
    const send = () =>
      request(app.getHttpServer())
        .post('/api/v1/me/reports')
        .set('Origin', 'http://localhost')
        .set('X-Forwarded-For', '192.0.2.9')
        .set('Authorization', 'Bearer user_member')
        .send(REPORT);
    for (let n = 0; n < WRITE_THROTTLE.limit; n++) await send().expect(201);
    await send().expect(429);
  });
});
