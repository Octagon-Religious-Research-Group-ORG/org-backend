/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  type INestApplication,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClerkAuthGuard } from '../src/auth/auth.guard';
import { configureHttpApp } from '../src/config/http-app';
import {
  DEFAULT_THROTTLE,
  SLUG_CHECK_THROTTLE,
  WRITE_THROTTLE,
} from '../src/config/throttle';
import {
  MembershipController,
  MyMembershipController,
} from '../src/membership/membership.controller';
import { MembershipService } from '../src/membership/membership.service';

const service = {
  terms: () => ({ version: 'v1', items: [] }),
  slugAvailability: () => Promise.resolve({ available: true }),
  recordGuestEntry: () => Promise.resolve(),
  summary: () => Promise.resolve({ status: 'none' }),
  join: jest.fn(() => Promise.resolve({ status: 'pending' })),
};

const signedIn: CanActivate = {
  canActivate(context: ExecutionContext) {
    context.switchToHttp().getRequest().auth = { payload: { sub: 'user_e2e' } };
    return true;
  },
};

/** A route with no scoped body limit: proves the wider limit does not leak. */
@Controller('other')
class OtherRouteController {
  @Post()
  echo(@Body() body: unknown) {
    return { received: typeof body };
  }
}

/** Real ThrottlerGuard and real HTTP setup; only the token check is swapped. */
async function build(auth: 'real' | 'fake'): Promise<INestApplication<App>> {
  const builder = Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([DEFAULT_THROTTLE])],
    controllers: [
      MembershipController,
      MyMembershipController,
      OtherRouteController,
    ],
    providers: [
      { provide: MembershipService, useValue: service },
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      {
        provide: ConfigService,
        useValue: { getOrThrow: () => 'sk_test_x,http://localhost' },
      },
    ],
  });
  if (auth === 'fake') builder.overrideGuard(ClerkAuthGuard).useValue(signedIn);
  const moduleRef = await builder.compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>();
  configureHttpApp(nest, { origins: ['http://localhost'], trustProxyHops: 1 });
  await nest.init();
  return nest;
}

describe('Membership guards over HTTP (e2e)', () => {
  let app: INestApplication<App>;

  afterEach(async () => {
    await app.close();
  });

  const slugCheck = () =>
    request(app.getHttpServer()).get(
      '/api/v1/membership/slug-availability?slug=abc',
    );

  describe('without a token', () => {
    beforeEach(async () => {
      app = await build('real');
    });

    it('refuses the address check, so a logged-out visitor learns nothing', async () => {
      await slugCheck().expect(401);
    });
  });

  describe('signed in', () => {
    beforeEach(async () => {
      app = await build('fake');
    });

    it('answers the address check with yes or no', async () => {
      await slugCheck().expect(200).expect({ available: true });
    });

    it('rations the address check per visitor', async () => {
      for (let i = 0; i < SLUG_CHECK_THROTTLE.limit; i++) {
        await slugCheck().expect(200);
      }
      await slugCheck().expect(429);
    });

    it('applies the write limit to joining', async () => {
      const post = () =>
        request(app.getHttpServer())
          .post('/api/v1/me/membership')
          .send({ not: 'valid' });
      for (let i = 0; i < WRITE_THROTTLE.limit; i++) {
        await post().expect(400);
      }
      await post().expect(429);
    });

    it('applies the write limit to guest entry', async () => {
      const post = () =>
        request(app.getHttpServer()).post('/api/v1/membership/guest-entry');
      for (let i = 0; i < WRITE_THROTTLE.limit; i++) {
        await post().expect(204);
      }
      await post().expect(429);
    });
  });
});
