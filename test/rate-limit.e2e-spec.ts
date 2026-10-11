import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { configureHttpApp } from '../src/config/http-app';
import {
  DEFAULT_THROTTLE,
  WRITE_THROTTLE,
  WriteThrottle,
} from '../src/config/throttle';

@Controller('probe')
class ProbeController {
  @Post()
  @WriteThrottle()
  write() {
    return { ok: true };
  }

  @Get()
  read() {
    return { ok: true };
  }
}

/**
 * Proves the production HTTP setup (trust proxy + throttler) buckets
 * requests per real visitor behind one proxy hop, as on Render/Heroku.
 */
describe('rate limiting behind a proxy (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([DEFAULT_THROTTLE])],
      controllers: [ProbeController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpApp(nest, { origins: [], trustProxyHops: 1 });
    await nest.init();
    app = nest;
  });

  afterEach(async () => {
    await app.close();
  });

  const write = (forwardedFor: string) =>
    request(app.getHttpServer())
      .post('/api/v1/probe')
      .set('X-Forwarded-For', forwardedFor);

  it('blocks a visitor after the write limit', async () => {
    for (let i = 0; i < WRITE_THROTTLE.limit; i++) {
      await write('203.0.113.7').expect(201);
    }
    await write('203.0.113.7').expect(429);
  });

  it('gives each visitor behind the proxy their own bucket', async () => {
    for (let i = 0; i < WRITE_THROTTLE.limit; i++) {
      await write('203.0.113.7').expect(201);
    }
    await write('198.51.100.9').expect(201);
  });

  it('ignores a forged leftmost X-Forwarded-For entry', async () => {
    for (let i = 0; i < WRITE_THROTTLE.limit; i++) {
      await write(`10.0.0.${i}, 203.0.113.7`).expect(201);
    }
    await write('10.9.9.9, 203.0.113.7').expect(429);
  });

  it('keeps reads on the higher site-wide limit', async () => {
    for (let i = 0; i <= WRITE_THROTTLE.limit; i++) {
      await request(app.getHttpServer())
        .get('/api/v1/probe')
        .set('X-Forwarded-For', '203.0.113.7')
        .expect(200);
    }
  });
});
