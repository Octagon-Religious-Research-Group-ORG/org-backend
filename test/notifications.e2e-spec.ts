// The notification routes (Chunk 14) through the real controllers,
// validation pipe, guards and throttles, with the services stubbed: who may
// reach which route, what a request may carry, that nothing is cached, and
// that the public unsubscribe route gives one answer to every bad link.
// Nothing here sends email. Synthetic data only.
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { DEFAULT_THROTTLE, WRITE_THROTTLE } from '../src/config/throttle';
import { readNotificationConfig } from '../src/member-notifications/notification-config';
import { NotificationDispatcher } from '../src/member-notifications/notification-dispatcher.service';
import { NotificationPrefsService } from '../src/member-notifications/notification-prefs.service';
import {
  AdminNotificationsController,
  BAD_UNSUBSCRIBE_LINK,
  MyNotificationSettingsController,
  UnsubscribeController,
} from '../src/member-notifications/notifications.controller';
import { signUnsubscribe } from '../src/member-notifications/unsubscribe-tokens';
import { fakeModel } from '../src/test-support/fake-model.mocks-spec';
import { required } from './members-test-app';

const CONFIG: Record<string, string> = {
  PUBLIC_APP_URL: 'https://org.example.test',
  CLERK_SECRET_KEY: 'sk_test_synthetic',
};

describe('notification routes (e2e)', () => {
  let app: INestApplication<App>;
  let address = 0;
  const ok = (value: unknown) => jest.fn(() => Promise.resolve(value));
  // The REAL settings service over an in-memory model, so a test sees
  // what a save stores, not only what the controller passed on (review
  // round 3: a DTO instance carries every optional field as undefined).
  let model: ReturnType<typeof fakeModel>;
  let prefs: {
    view: jest.SpyInstance;
    update: jest.SpyInstance;
    unsubscribe: jest.SpyInstance;
  };
  let service: NotificationPrefsService;
  const dispatcher = { status: ok({ enabled: false }) };
  const isAdmin = (req: { auth?: { payload: { sub: string } } }) =>
    Promise.resolve(req.auth?.payload.sub.startsWith('user_admin') === true);
  const key = readNotificationConfig({
    get: (k: string) => CONFIG[k],
    getOrThrow: (k: string) => CONFIG[k],
  } as never).signingKey;
  const call = (
    method: 'get' | 'put' | 'post',
    path: string,
    user?: string,
    ip?: string,
  ) => {
    address++;
    const req = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('Origin', 'http://localhost')
      .set('X-Forwarded-For', ip ?? `198.51.100.${address % 250}`);
    return user ? req.set('Authorization', `Bearer ${user}`) : req;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    model = fakeModel([], { unique: [['userId']] });
    service = new NotificationPrefsService(model as never);
    prefs = {
      view: jest.spyOn(service, 'view'),
      update: jest.spyOn(service, 'update'),
      unsubscribe: jest.spyOn(service, 'unsubscribe'),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([DEFAULT_THROTTLE])],
      controllers: [
        MyNotificationSettingsController,
        UnsubscribeController,
        AdminNotificationsController,
      ],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        Reflector,
        AdminRoleGuard,
        { provide: NotificationPrefsService, useValue: service },
        { provide: NotificationDispatcher, useValue: dispatcher },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) => CONFIG[k],
            getOrThrow: (k: string) => CONFIG[k],
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

  it('needs a sign-in for a member’s own settings, and stores them nowhere', async () => {
    await call('get', '/me/notification-settings').expect(401);
    await call('put', '/me/notification-settings').send({}).expect(401);
    expect(prefs.view).not.toHaveBeenCalled();
    const mine = await call(
      'get',
      '/me/notification-settings',
      'user_member',
    ).expect(200);
    expect(mine.headers['cache-control']).toBe('private, no-store');
    expect(prefs.view).toHaveBeenCalledWith('user_member', false);
    const saved = await call('put', '/me/notification-settings', 'user_admin')
      .send({
        categories: { replies: false, adminReports: true },
        digest: false,
      })
      .expect(200);
    expect(saved.headers['cache-control']).toBe('private, no-store');
    expect(prefs.update).toHaveBeenCalledTimes(1);
    expect((prefs.update.mock.calls[0] as unknown[]).slice(0, 2)).toEqual([
      'user_admin',
      true,
    ]);
    // What was STORED: exactly the named changes, nothing else switched.
    expect(model.docs).toHaveLength(1);
    expect(model.docs[0].off).toEqual(['replies']);
    expect(model.docs[0].digest).toBe(false);
    expect(model.docs[0]).not.toHaveProperty('immediate');
    expect(model.docs[0]).not.toHaveProperty('adminImmediate');
    expect(saved.body).toEqual({
      categories: {
        comments: true,
        replies: false,
        suggestions: true,
        votes: true,
        claims: true,
        moderation: true,
      },
      digest: false,
      immediate: true,
      admin: {
        categories: {
          adminPages: true,
          adminEam: true,
          adminReports: true,
          adminClaims: true,
        },
        adminImmediate: true,
      },
    });
  });

  it('a one-field save through the real validation pipe changes that field only (review round 3, HIGH 1)', async () => {
    await call('put', '/me/notification-settings', 'user_member')
      .send({ categories: { votes: false } })
      .expect(200);
    expect(model.docs[0].off).toEqual(['votes']);
    await call('put', '/me/notification-settings', 'user_member')
      .send({ immediate: false })
      .expect(200);
    expect(model.docs[0].off).toEqual(['votes']);
    expect(model.docs[0]).toMatchObject({ immediate: false });
    expect(model.docs[0]).not.toHaveProperty('digest');
    // JSON null is "no value", never a switch either way.
    await call('put', '/me/notification-settings', 'user_member')
      .send({ digest: null, categories: { replies: null } })
      .expect(200);
    expect(model.docs[0].off).toEqual(['votes']);
    expect(model.docs[0]).not.toHaveProperty('digest');
  });

  it('accepts only known settings, each a true or false', async () => {
    for (const body of [
      { digest: 'yes' },
      { categories: { replies: 'no' } },
      { categories: { everything: false } },
      { email: 'someone@example.test' },
      { categories: 'all' },
    ]) {
      const response = await call(
        'put',
        '/me/notification-settings',
        'user_member',
      ).send(body);
      expect([JSON.stringify(body), response.status]).toEqual([
        JSON.stringify(body),
        400,
      ]);
    }
    expect(prefs.update).not.toHaveBeenCalled();
  });

  it('unsubscribes without a sign-in, from the page or a mail client’s one-click', async () => {
    const token = signUnsubscribe(key, 'user_member', 'digest');
    const page = await call('post', '/notifications/unsubscribe')
      .send({ token })
      .expect(200);
    expect(page.body).toEqual({ unsubscribed: true, scope: 'digest' });
    expect(page.headers['cache-control']).toBe('no-store');
    // RFC 8058: form-encoded "List-Unsubscribe=One-Click", token in the URL.
    await call(
      'post',
      `/notifications/unsubscribe?token=${encodeURIComponent(token)}`,
    )
      .type('form')
      .send('List-Unsubscribe=One-Click')
      .expect(200);
    expect(prefs.unsubscribe).toHaveBeenCalledTimes(2);
    expect(prefs.unsubscribe).toHaveBeenCalledWith('user_member', 'digest');
  });

  it('answers every bad link the same, changing nothing', async () => {
    const foreign = signUnsubscribe(
      Buffer.from('z'.repeat(32)),
      'user_member',
      'digest',
    );
    const answers = new Set<string>();
    for (const body of [
      {},
      { token: 'nonsense' },
      { token: foreign },
      { token: 7 },
    ]) {
      const response = await call('post', '/notifications/unsubscribe')
        .send(body)
        .expect(400);
      answers.add(JSON.stringify(response.body));
    }
    expect(answers.size).toBe(1);
    expect([...answers][0]).toContain(BAD_UNSUBSCRIBE_LINK);
    expect(prefs.unsubscribe).not.toHaveBeenCalled();
  });

  it('limits the unsubscribe route per visitor', async () => {
    const token = signUnsubscribe(key, 'user_member', 'replies');
    for (let n = 0; n < WRITE_THROTTLE.limit; n++) {
      await call('post', '/notifications/unsubscribe', undefined, '192.0.2.9')
        .send({ token })
        .expect(200);
    }
    await call('post', '/notifications/unsubscribe', undefined, '192.0.2.9')
      .send({ token })
      .expect(429);
  });

  it('shows the email status to admins only, stored nowhere', async () => {
    await call('get', '/admin/notifications').expect(401);
    await call('get', '/admin/notifications', 'user_member').expect(403);
    expect(dispatcher.status).not.toHaveBeenCalled();
    const status = await call(
      'get',
      '/admin/notifications',
      'user_admin',
    ).expect(200);
    expect(status.headers['cache-control']).toBe('private, no-store');
    expect(status.body).toEqual({ enabled: false });
  });
});
