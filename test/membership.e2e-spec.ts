/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClerkAuthGuard } from '../src/auth/auth.guard';
import { configureHttpApp } from '../src/config/http-app';
import {
  MembershipController,
  MyMembershipController,
} from '../src/membership/membership.controller';
import { MembershipService } from '../src/membership/membership.service';

/** The request shape is checked by the real ValidationPipe, before any service code. */
describe('Membership API (e2e)', () => {
  let app: INestApplication<App>;
  const service = {
    terms: jest.fn(() => ({ version: 'v1', items: [] })),
    slugAvailability: jest.fn(() => Promise.resolve({ available: true })),
    recordGuestEntry: jest.fn(() => Promise.resolve()),
    summary: jest.fn(() => Promise.resolve({ status: 'none' })),
    join: jest.fn(() => Promise.resolve({ status: 'pending' })),
  };
  const signedIn: CanActivate = {
    canActivate(context: ExecutionContext) {
      context.switchToHttp().getRequest().auth = {
        payload: { sub: 'user_e2e' },
      };
      return true;
    },
  };

  const valid = {
    displayName: 'Stalemate',
    slug: 'stalemate',
    anonymous: true,
    visibility: 'named-members',
    bio: 'Hello.',
    beliefs: [{ title: 'God', text: 'One.' }],
    contacts: [],
    backupContacts: [{ method: 'signal', value: '@me' }],
    termsVersion: 'v1',
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MembershipController, MyMembershipController],
      providers: [{ provide: MembershipService, useValue: service }],
    })
      .overrideGuard(ClerkAuthGuard)
      .useValue(signedIn)
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

  beforeEach(() => service.join.mockClear());

  it('serves the terms and records a guest with the real client IP', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/membership/terms')
      .expect(200)
      .expect({ version: 'v1', items: [] });
    await request(app.getHttpServer())
      .post('/api/v1/membership/guest-entry')
      .set('X-Forwarded-For', '6.6.6.6, 203.0.113.7')
      .expect(204);
    expect(service.recordGuestEntry).toHaveBeenCalledWith(
      expect.objectContaining({ ip: '203.0.113.7' }),
    );
  });

  it('accepts a complete membership for the signed-in member', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/me/membership')
      .send(valid)
      .expect(201)
      .expect({ status: 'pending' });
    expect(service.join).toHaveBeenCalledWith(
      'user_e2e',
      expect.objectContaining({ slug: 'stalemate', anonymous: true }),
      expect.any(Object),
    );
  });

  it.each([
    ['an unknown field', { ...valid, isAdmin: true }],
    ['an unknown visibility', { ...valid, visibility: 'friends' }],
    ['no beliefs', { ...valid, beliefs: [] }],
    [
      'a belief without text',
      { ...valid, beliefs: [{ title: 'x', text: '' }] },
    ],
    [
      'an unknown field inside a belief',
      { ...valid, beliefs: [{ title: 'x', text: 'y', order: 9 }] },
    ],
    ['no backup contact', { ...valid, backupContacts: [] }],
    [
      'an unknown contact method',
      { ...valid, contacts: [{ method: 'fax', value: '1' }] },
    ],
    ['a non-boolean anonymous flag', { ...valid, anonymous: 'yes' }],
    ['no terms version', { ...valid, termsVersion: undefined }],
  ])('rejects %s before the service runs', async (_label, body) => {
    await request(app.getHttpServer())
      .post('/api/v1/me/membership')
      .send(body)
      .expect(400);
    expect(service.join).not.toHaveBeenCalled();
  });
});
