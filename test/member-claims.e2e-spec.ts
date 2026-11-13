/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// The claims routes (Chunk 11) through the real controllers, validation pipe,
// guards and throttles, with the services stubbed: who may reach which route
// and what a request may carry. What the services do is tested against a
// real MongoDB in member-claims-mongo.e2e-spec.ts. Synthetic data only.
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
  CLAIM_REQUEST_ACCOUNT_THROTTLE,
  CLAIM_REQUEST_DAILY_LIMIT_CODE,
  DEFAULT_THROTTLE,
} from '../src/config/throttle';
import { ClaimRequestThrottleGuard } from '../src/members/claims/claim-request-throttle.guard';
import {
  AdminClaimsController,
  AdminClaimWritesController,
  MyClaimsController,
  MyClaimWritesController,
} from '../src/members/claims/claims.controller';
import { MAX_LINKED_PER_REQUEST } from '../src/members/claims/claims.dto';
import { ClaimsService } from '../src/members/claims/claims.service';
import { LegacyLinksService } from '../src/members/claims/legacy-links.service';
import { MemberWriteThrottleGuard } from '../src/members/member-write-throttle.guard';
import { MembersService } from '../src/members/members.service';
import { required } from './members-test-app';

const CLAIM = '0123456789abcdef01234567';

describe('claims API (e2e)', () => {
  let app: INestApplication<App>;
  let address = 0;
  const claims = {
    mine: jest.fn(() => Promise.resolve({ mayClaim: true, claims: [] })),
    request: jest.fn(() => Promise.resolve({ claimId: CLAIM })),
    withdraw: jest.fn(() => Promise.resolve({ withdrawn: true })),
    adminList: jest.fn(() => Promise.resolve({ claims: [] })),
    approve: jest.fn(() => Promise.resolve({ approved: true })),
    reject: jest.fn(() => Promise.resolve({ rejected: true })),
  };
  const links = {
    candidates: jest.fn(() => Promise.resolve({ comments: [] })),
    link: jest.fn(() => Promise.resolve({ linked: [], skipped: [] })),
    unlink: jest.fn(() => Promise.resolve({ unlinked: [], skipped: [] })),
  };
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
      .set('X-Forwarded-For', `203.0.113.${address % 250}`);
    return user ? req.set('Authorization', `Bearer ${user}`) : req;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([DEFAULT_THROTTLE])],
      controllers: [
        MyClaimsController,
        MyClaimWritesController,
        AdminClaimsController,
        AdminClaimWritesController,
      ],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        Reflector,
        AdminRoleGuard,
        MemberWriteThrottleGuard,
        ClaimRequestThrottleGuard,
        { provide: ClaimsService, useValue: claims },
        { provide: LegacyLinksService, useValue: links },
        {
          provide: MembersService,
          useValue: {
            resolveViewer: (req: { auth: { payload: { sub: string } } }) =>
              Promise.resolve({
                kind: 'signed-in',
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
    for (const [method, path] of [
      ['get', '/me/claims'],
      ['post', '/me/claims'],
      ['delete', `/me/claims/${CLAIM}`],
      ['get', '/admin/claims'],
      ['get', `/admin/claims/${CLAIM}/legacy-comments`],
      ['post', `/admin/claims/${CLAIM}/approve`],
      ['post', `/admin/claims/${CLAIM}/reject`],
      ['post', `/admin/claims/${CLAIM}/legacy-comments/link`],
      ['post', `/admin/claims/${CLAIM}/legacy-comments/unlink`],
    ] as const) {
      await call(method, path).expect(401);
    }
    expect(claims.mine).not.toHaveBeenCalled();
  });

  it('keeps the queue and every decision to admins', async () => {
    for (const [method, path] of [
      ['get', '/admin/claims'],
      ['get', `/admin/claims/${CLAIM}/legacy-comments`],
      ['post', `/admin/claims/${CLAIM}/approve`],
      ['post', `/admin/claims/${CLAIM}/reject`],
      ['post', `/admin/claims/${CLAIM}/legacy-comments/link`],
      ['post', `/admin/claims/${CLAIM}/legacy-comments/unlink`],
    ] as const) {
      // A valid body, so only the role check can refuse it.
      await call(method, path, 'user_member')
        .send(path.endsWith('link') ? { commentIds: ['c1'] } : {})
        .expect(403);
    }
    expect(claims.adminList).not.toHaveBeenCalled();
    expect(claims.approve).not.toHaveBeenCalled();
    expect(claims.reject).not.toHaveBeenCalled();
    expect(links.candidates).not.toHaveBeenCalled();
    expect(links.link).not.toHaveBeenCalled();
    expect(links.unlink).not.toHaveBeenCalled();
    const queue = await call(
      'get',
      '/admin/claims?status=rejected',
      'user_admin',
    ).expect(200);
    expect(queue.headers['cache-control']).toBe('private, no-store');
    expect(claims.adminList).toHaveBeenCalledWith('rejected');
    await call('post', `/admin/claims/${CLAIM}/approve`, 'user_admin').expect(
      201,
    );
    expect(claims.approve).toHaveBeenCalledWith('user_admin', CLAIM);
  });

  it('gives a member their own requests, stored by no cache', async () => {
    const mine = await call('get', '/me/claims', 'user_member').expect(200);
    expect(mine.headers['cache-control']).toBe('private, no-store');
    expect(claims.mine).toHaveBeenCalledWith('user_member');
  });

  it('accepts only the fields a request may carry', async () => {
    await call('post', '/me/claims', 'user_member')
      .send({ slug: 'a-page', message: 'Synthetic', ownerUserId: 'me' })
      .expect(400);
    await call('post', '/me/claims', 'user_member')
      .send({ slug: 'a page!', message: 'Synthetic' })
      .expect(400);
    await call('post', '/me/claims', 'user_member')
      .send({ slug: 'a-page' })
      .expect(400);
    await call('post', '/me/claims', 'user_member')
      .send({ slug: 'a-page', message: 'x'.repeat(6001) })
      .expect(400);
    await call('get', '/admin/claims?status=everything', 'user_admin').expect(
      400,
    );
    await call(
      'post',
      `/admin/claims/${CLAIM}/legacy-comments/link`,
      'user_admin',
    )
      .send({ commentIds: [] })
      .expect(400);
    await call(
      'post',
      `/admin/claims/${CLAIM}/legacy-comments/link`,
      'user_admin',
    )
      .send({
        commentIds: Array.from(
          { length: MAX_LINKED_PER_REQUEST + 1 },
          (_, i) => `c${i}`,
        ),
      })
      .expect(400);
    await call(
      'post',
      `/admin/claims/${CLAIM}/legacy-comments/link`,
      'user_admin',
    )
      .send({ commentIds: ['bad id'] })
      .expect(400);
    expect(claims.request).not.toHaveBeenCalled();
    expect(links.link).not.toHaveBeenCalled();

    await call('post', '/me/claims', 'user_member')
      .send({ slug: 'A-Page', message: 'Synthetic' })
      .expect(201);
    expect(claims.request).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_member' }),
      'A-Page',
      'Synthetic',
    );
  });

  it('rations claim requests per account per day, with its own code', async () => {
    for (let n = 0; n < CLAIM_REQUEST_ACCOUNT_THROTTLE.limit; n++) {
      await call('post', '/me/claims', 'user_eager')
        .send({ slug: 'a-page', message: 'Synthetic' })
        .expect(201);
    }
    const refused = await call('post', '/me/claims', 'user_eager')
      .send({ slug: 'a-page', message: 'Synthetic' })
      .expect(429);
    expect(refused.body.code).toBe(CLAIM_REQUEST_DAILY_LIMIT_CODE);
    // Withdrawing is not a request; another account has its own ration.
    await call('delete', `/me/claims/${CLAIM}`, 'user_eager').expect(200);
    await call('post', '/me/claims', 'user_other')
      .send({ slug: 'a-page', message: 'Synthetic' })
      .expect(201);
  });
});
