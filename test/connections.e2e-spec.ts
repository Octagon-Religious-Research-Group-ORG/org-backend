// Connection requests (Chunk 18) over HTTP, with the shared HTTP setup
// (`configureHttpApp`): sign-in on every member route, admins only on the
// rename, validation of every body and id, no-store, and the write guard
// that refuses a deleted account. Services are faked; the real-database half
// is connections-mongo.e2e-spec.ts. Synthetic data only.
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AdminAccessService } from '../src/auth/admin-access.service';
import { AdminRoleGuard } from '../src/auth/admin-role.guard';
import { ClerkAuthGuard } from '../src/auth/auth.guard';
import { configureHttpApp } from '../src/config/http-app';
import { DEFAULT_THROTTLE } from '../src/config/throttle';
import { ConnectionTermsService } from '../src/connections/connection-terms.service';
import { ConnectionViews } from '../src/connections/connection-views.service';
import {
  AdminConnectionTermsController,
  ConnectionTermsController,
  MyConnectionsController,
  MyConnectionWritesController,
} from '../src/connections/connections.controller';
import { ConnectionsService } from '../src/connections/connections.service';
import { AccountDeletion } from '../src/member-data/schemas/account-deletion.schema';
import { AccountNotDeletedGuard } from '../src/members/account-not-deleted.guard';
import { MemberWriteThrottleGuard } from '../src/members/member-write-throttle.guard';
import { fakeModel } from '../src/test-support/fake-model.mocks-spec';
import { required } from './members-test-app';

const ID = '0123456789abcdef01234567';

describe('connection routes (Chunk 18)', () => {
  let app: INestApplication<App>;
  const ok = () => jest.fn(() => Promise.resolve({ ok: true }));
  const writes = {
    send: ok(),
    accept: ok(),
    decline: ok(),
    withdraw: ok(),
    disconnect: ok(),
    block: ok(),
    unblock: ok(),
    updateSettings: ok(),
  };
  const views = { overview: ok(), relation: ok() };
  const terms = {
    terms: jest.fn(() =>
      Promise.resolve({
        singular: 'connection request',
        plural: 'connection requests',
      }),
    ),
    setTerms: ok(),
  };
  const isAdmin = (req: { auth?: { payload: { sub: string } } }) =>
    Promise.resolve(Boolean(req.auth?.payload.sub.startsWith('user_admin')));

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([DEFAULT_THROTTLE])],
      controllers: [
        ConnectionTermsController,
        MyConnectionsController,
        MyConnectionWritesController,
        AdminConnectionTermsController,
      ],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        Reflector,
        AdminRoleGuard,
        AccountNotDeletedGuard,
        MemberWriteThrottleGuard,
        {
          provide: getModelToken(AccountDeletion.name),
          useValue: fakeModel([{ userId: 'user_gone' }]),
        },
        { provide: ConnectionsService, useValue: writes },
        { provide: ConnectionViews, useValue: views },
        { provide: ConnectionTermsService, useValue: terms },
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
  const server = () => request(app.getHttpServer());

  it('gives the feature’s name to anyone', async () => {
    const res = await server().get('/api/v1/connections/terms').expect(200);
    expect(res.body).toEqual({
      singular: 'connection request',
      plural: 'connection requests',
    });
  });

  it('needs a sign-in on every member route, and an admin to rename', async () => {
    const routes: Array<['get' | 'post' | 'put' | 'delete', string]> = [
      ['get', '/api/v1/me/connections'],
      ['get', '/api/v1/me/connections/with/member-b'],
      ['post', '/api/v1/me/connections'],
      ['post', `/api/v1/me/connections/${ID}/accept`],
      ['post', `/api/v1/me/connections/${ID}/decline`],
      ['post', `/api/v1/me/connections/${ID}/withdraw`],
      ['post', `/api/v1/me/connections/${ID}/disconnect`],
      ['post', '/api/v1/me/connections/blocks'],
      ['delete', `/api/v1/me/connections/blocks/${ID}`],
      ['put', '/api/v1/me/connections/settings'],
      ['put', '/api/v1/admin/settings/connection-name'],
    ];
    for (const [method, path] of routes) {
      await server()[method](path).send({}).expect(401);
    }
    await server()
      .put('/api/v1/admin/settings/connection-name')
      .set(as('user_member'))
      .send({ singular: 'a', plural: 'b' })
      .expect(403);
    await server()
      .put('/api/v1/admin/settings/connection-name')
      .set(as('user_admin'))
      .send({ singular: 'introduction', plural: 'introductions' })
      .expect(200);
    expect(terms.setTerms).toHaveBeenCalledWith(
      'introduction',
      'introductions',
      'user_admin',
    );
  });

  it('passes the signed-in account and the request’s fields, never stored by a cache', async () => {
    const res = await server()
      .get('/api/v1/me/connections')
      .set(as('user_a'))
      .expect(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(views.overview).toHaveBeenCalledWith('user_a');
    await server()
      .get('/api/v1/me/connections/with/member-b')
      .set(as('user_a'))
      .expect(200);
    expect(views.relation).toHaveBeenCalledWith('user_a', 'member-b');
    await server()
      .post('/api/v1/me/connections')
      .set(as('user_a'))
      .send({ slug: 'Member-B', note: 'hello' })
      .expect(201);
    expect(writes.send).toHaveBeenCalledWith('user_a', 'Member-B', 'hello');
    for (const action of ['accept', 'decline', 'withdraw', 'disconnect']) {
      await server()
        .post(`/api/v1/me/connections/${ID}/${action}`)
        .set(as('user_a'))
        .expect(200);
    }
    await server()
      .post('/api/v1/me/connections/blocks')
      .set(as('user_a'))
      .send({ connectionId: ID })
      .expect(200);
    expect(writes.block).toHaveBeenCalledWith('user_a', { connectionId: ID });
    await server()
      .put('/api/v1/me/connections/settings')
      .set(as('user_a'))
      .send({
        openTo: 'public-members',
        contacts: [{ method: 'signal', value: 'alice.example' }],
      })
      .expect(200);
    expect(writes.updateSettings).toHaveBeenCalledWith('user_a', {
      openTo: 'public-members',
      contacts: [{ method: 'signal', value: 'alice.example' }],
    });
  });

  it('refuses malformed bodies before any service runs', async () => {
    const bad: Array<[string, string, Record<string, unknown>]> = [
      ['post', '/api/v1/me/connections', {}],
      ['post', '/api/v1/me/connections', { slug: 'not a slug!' }],
      [
        'post',
        '/api/v1/me/connections',
        { slug: 'ok', note: 'x'.repeat(1501) },
      ],
      ['post', '/api/v1/me/connections', { slug: 'ok', extra: 1 }],
      ['post', '/api/v1/me/connections/blocks', { connectionId: 'nope' }],
      ['put', '/api/v1/me/connections/settings', { openTo: 'everyone' }],
      [
        'put',
        '/api/v1/me/connections/settings',
        { contacts: [{ method: 'fax', value: 'x' }] },
      ],
      [
        'put',
        '/api/v1/me/connections/settings',
        {
          contacts: Array.from({ length: 11 }, () => ({
            method: 'email',
            value: 'a@example.org',
          })),
        },
      ],
    ];
    for (const [method, path, body] of bad) {
      await (server() as unknown as Record<string, (p: string) => request.Test>)
        [method](path)
        .set(as('user_a'))
        .send(body)
        .expect(400);
    }
    expect(writes.send).not.toHaveBeenCalled();
    expect(writes.block).not.toHaveBeenCalled();
    expect(writes.updateSettings).not.toHaveBeenCalled();
  });

  it('refuses every write from a deleted account', async () => {
    await server()
      .post('/api/v1/me/connections')
      .set(as('user_gone'))
      .send({ slug: 'member-b' })
      .expect(403);
    await server()
      .post(`/api/v1/me/connections/${ID}/accept`)
      .set(as('user_gone'))
      .expect(403);
    expect(writes.send).not.toHaveBeenCalled();
    expect(writes.accept).not.toHaveBeenCalled();
  });
});
