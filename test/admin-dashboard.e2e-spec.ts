// The admin dashboard routes (Chunk 12) through the real controllers,
// validation pipe, guards and throttles, with the services stubbed: who may
// reach which route, what a request may carry, and that nothing is cached.
// What the services do against a real database is in
// admin-dashboard-mongo.e2e-spec.ts. Synthetic data only.
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { AdminInboxService } from '../src/admin-inbox/admin-inbox.service';
import { AdminAccessService } from '../src/auth/admin-access.service';
import { AdminRoleGuard } from '../src/auth/admin-role.guard';
import { ClerkAuthGuard } from '../src/auth/auth.guard';
import { configureHttpApp } from '../src/config/http-app';
import { DEFAULT_THROTTLE, WRITE_THROTTLE } from '../src/config/throttle';
import {
  AdminDashboardController,
  AdminDashboardWritesController,
  MyEamRequestController,
  MyEamRequestWritesController,
} from '../src/members/admin/admin.controller';
import { AdminLogService } from '../src/members/admin/admin-log.service';
import { AdminMembersService } from '../src/members/admin/admin-members.service';
import { AdminRolesService } from '../src/members/admin/admin-roles.service';
import { EamRequestsService } from '../src/members/admin/eam-requests.service';
import { MemberWriteThrottleGuard } from '../src/members/member-write-throttle.guard';
import { MembersService } from '../src/members/members.service';
import { OrgSettingsService } from '../src/members/org-settings.service';
import { required } from './members-test-app';

const ENTRY = '0123456789abcdef01234567';

describe('admin dashboard API (e2e)', () => {
  let app: INestApplication<App>;
  let address = 0;
  const ok = (value: unknown) => jest.fn(() => Promise.resolve(value));
  const roles = {
    admins: ok({ admins: [], complete: true }),
    invitations: ok([]),
    promote: ok({ role: 'admin' }),
    demote: ok({ role: null }),
    invite: ok({ invitationId: 'inv_1' }),
    revokeInvitation: ok({ revoked: true }),
  };
  const members = {
    list: ok({ members: [], hasMore: false }),
    approve: ok({}),
    reject: ok({}),
    remove: ok({}),
    restore: ok({}),
  };
  const log = { page: ok({ entries: [], hasMore: false }) };
  const inbox = {
    list: ok({ entries: [], hasMore: false }),
    markHandled: ok({}),
    resetEam: ok({}),
  };
  const settings = { adminView: ok({ anonymousMayVote: false }) };
  const eam = { status: ok({ mayRequest: true }), request: ok({}) };
  const isAdmin = (req: { auth: { payload: { sub: string } } }) =>
    Promise.resolve(req.auth.payload.sub.startsWith('user_admin'));
  const call = (
    method: 'get' | 'post' | 'delete',
    path: string,
    user?: string,
  ) => {
    address++;
    const req = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('Origin', 'http://localhost')
      .set('X-Forwarded-For', `198.51.100.${address % 250}`);
    return user ? req.set('Authorization', `Bearer ${user}`) : req;
  };

  const ADMIN_ROUTES = [
    ['get', '/admin/roles', undefined],
    ['get', '/admin/invitations', undefined],
    ['get', '/admin/members', undefined],
    ['get', '/admin/log', undefined],
    ['get', '/admin/inbox', undefined],
    ['get', '/admin/settings', undefined],
    ['post', '/admin/roles/user_x/promote', { reason: 'r' }],
    ['post', '/admin/roles/user_x/demote', { reason: 'r' }],
    ['post', '/admin/invitations', { email: 'a@example.org', as: 'member' }],
    ['delete', '/admin/invitations/inv_1', undefined],
    ['post', '/admin/members/a-page/approve', undefined],
    ['post', '/admin/members/a-page/reject', { reason: 'r' }],
    ['post', '/admin/members/a-page/remove', { reason: 'r' }],
    ['post', '/admin/members/a-page/restore', { reason: 'r' }],
    ['post', `/admin/inbox/${ENTRY}/handled`, undefined],
    ['post', `/admin/inbox/${ENTRY}/reset-eam`, undefined],
  ] as const;

  const allServiceCalls = () =>
    [roles, members, log, inbox, settings]
      .flatMap((service) => Object.values(service))
      .reduce((sum, fn) => sum + fn.mock.calls.length, 0);

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([DEFAULT_THROTTLE])],
      controllers: [
        AdminDashboardController,
        AdminDashboardWritesController,
        MyEamRequestController,
        MyEamRequestWritesController,
      ],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        Reflector,
        AdminRoleGuard,
        MemberWriteThrottleGuard,
        { provide: AdminRolesService, useValue: roles },
        { provide: AdminMembersService, useValue: members },
        { provide: AdminLogService, useValue: log },
        { provide: AdminInboxService, useValue: inbox },
        { provide: OrgSettingsService, useValue: settings },
        { provide: EamRequestsService, useValue: eam },
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

  it('needs a sign-in on every route', async () => {
    for (const [method, path, body] of ADMIN_ROUTES) {
      await call(method, path)
        .send(body ?? {})
        .expect(401);
    }
    await call('get', '/me/eam-request').expect(401);
    await call('post', '/me/eam-request').send({}).expect(401);
    expect(allServiceCalls()).toBe(0);
    expect(eam.status).not.toHaveBeenCalled();
  });

  it('shows a member who is not an admin nothing, and lets them change nothing', async () => {
    for (const [method, path, body] of ADMIN_ROUTES) {
      // A valid body, so only the role check can refuse it.
      await call(method, path, 'user_member')
        .send(body ?? {})
        .expect(403);
    }
    expect(allServiceCalls()).toBe(0);
  });

  it('answers admins, stored by no cache', async () => {
    for (const [method, path, body] of ADMIN_ROUTES) {
      const response = await call(method, path, 'user_admin').send(body ?? {});
      expect([path, response.status]).toEqual([
        path,
        method === 'get' || method === 'delete' ? 200 : 201,
      ]);
      expect(response.headers['cache-control']).toBe('private, no-store');
    }
    expect(roles.promote).toHaveBeenCalledWith('user_admin', 'user_x', 'r');
    expect(members.list).toHaveBeenCalledWith('all', undefined, 1);
    expect(inbox.list).toHaveBeenCalledWith('open', 1);
  });

  it('accepts only the fields and values each route may carry', async () => {
    const bad: Array<['get' | 'post', string, object?]> = [
      ['get', '/admin/members?status=everything'],
      ['get', '/admin/members?page=0'],
      ['get', `/admin/members?q=${'x'.repeat(101)}`],
      ['get', '/admin/log?page=abc'],
      ['get', '/admin/inbox?status=deleted'],
      ['post', '/admin/roles/user_x/promote', {}],
      ['post', '/admin/roles/user_x/promote', { reason: 'r', role: 'owner' }],
      ['post', '/admin/invitations', { email: 'not-an-email', as: 'member' }],
      ['post', '/admin/invitations', { email: 'a@example.org', as: 'owner' }],
      ['post', '/admin/members/a-page/remove', {}],
      ['post', '/admin/members/a-page/remove', { reason: 'x'.repeat(1501) }],
    ];
    for (const [method, path, body] of bad) {
      const response = await call(method, path, 'user_admin').send(body ?? {});
      expect([path, response.status]).toEqual([path, 400]);
    }
    await call('post', '/me/eam-request', 'user_member')
      .send({ note: 'x'.repeat(3001) })
      .expect(400);
    // Malformed ids are "no such thing", never a lookup.
    await call('post', '/admin/roles/admin/promote', 'user_admin')
      .send({ reason: 'r' })
      .expect(404);
    await call('delete', '/admin/invitations/user_1', 'user_admin').expect(404);
    expect(allServiceCalls()).toBe(0);
    expect(eam.request).not.toHaveBeenCalled();
  });

  it('gives a member their own EaM state, and lets them ask', async () => {
    const state = await call('get', '/me/eam-request', 'user_member').expect(
      200,
    );
    expect(state.headers['cache-control']).toBe('private, no-store');
    await call('post', '/me/eam-request', 'user_member')
      .send({ note: 'Synthetic note' })
      .expect(201);
    expect(eam.request).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_member' }),
      'Synthetic note',
    );
  });

  it('limits each write route per visitor like every member write', async () => {
    for (let n = 0; n < WRITE_THROTTLE.limit; n++) {
      await request(app.getHttpServer())
        .post(`/api/v1/admin/inbox/${ENTRY}/handled`)
        .set('Origin', 'http://localhost')
        .set('X-Forwarded-For', '192.0.2.7')
        .set('Authorization', 'Bearer user_admin')
        .expect(201);
    }
    await request(app.getHttpServer())
      .post(`/api/v1/admin/inbox/${ENTRY}/handled`)
      .set('Origin', 'http://localhost')
      .set('X-Forwarded-For', '192.0.2.7')
      .set('Authorization', 'Bearer user_admin')
      .expect(429);
  });
});
