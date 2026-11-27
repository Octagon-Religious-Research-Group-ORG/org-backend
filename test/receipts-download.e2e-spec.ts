// The receipt zip download over real HTTP (NestJS 12 plan, chunk 7): the real
// controller, guards, interceptors and HTTP setup, with the receipt itself
// faked. A unit test cannot see what an interceptor or the HTTP layer does to
// a binary body sent with `res.send`; this does. Synthetic data only.
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { strFromU8, unzipSync } from 'fflate';
import request from 'supertest';
import { App } from 'supertest/types';
import { buildReceipt, receiptZip } from '../src/anchoring/receipt';
import { ClerkAuthGuard, OptionalClerkAuthGuard } from '../src/auth/auth.guard';
import { configureHttpApp } from '../src/config/http-app';
import { DEFAULT_THROTTLE } from '../src/config/throttle';
import { MembersService } from '../src/members/members.service';
import { ReceiptsController } from '../src/members/receipts/receipts.controller';
import { ReceiptsService } from '../src/members/receipts/receipts.service';

const receipt = {
  ...buildReceipt(
    { type: 'comment', page: 'open-page', commentId: 'c' },
    [],
    { isAdmin: false },
    new Date('2026-11-14T00:00:00Z'),
  ),
  versions: [
    {
      seq: 3,
      text: 'Synthetic text.',
      hashInput: { included: false, withheld: [], reason: 'held back' },
      anchor: { state: 'pending', message: 'Not anchored yet.' },
    },
  ],
} as never;

describe('receipt zip download over HTTP', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([DEFAULT_THROTTLE])],
      controllers: [ReceiptsController],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        OptionalClerkAuthGuard,
        {
          provide: ClerkAuthGuard,
          useValue: { canActivate: () => false },
        },
        {
          provide: ConfigService,
          useValue: { get: () => undefined, getOrThrow: () => 'x' },
        },
        {
          provide: MembersService,
          useValue: { resolveViewer: () => ({ kind: 'guest' }) },
        },
        {
          provide: ReceiptsService,
          useValue: {
            belief: () => Promise.resolve(receipt),
            comment: () => Promise.resolve(receipt),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpApp(app as NestExpressApplication, {
      trustProxyHops: 1,
      origins: ['http://localhost:3000'],
    });
    await app.init();
  });

  afterAll(() => app.close());

  it.each([
    [
      'a belief',
      '/api/v1/members/profiles/open-page/tabs/tab_a/receipt/download',
      'receipt-open-page-tab_a-text-3.zip',
    ],
    [
      'a comment',
      '/api/v1/members/profiles/open-page/comments/cmt_1/receipt/download',
      'receipt-open-page-cmt_1-3.zip',
    ],
  ])('sends %s receipt as the exact zip bytes', async (_what, path, name) => {
    const res = await request(app.getHttpServer())
      .get(path)
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="${name}"`,
    );
    // Compared file by file: a zip stamps each file with the time it was
    // made, so two zips of the same receipt differ in those bytes.
    const sent = unzipSync(new Uint8Array(res.body as Buffer));
    const expected = unzipSync(receiptZip(receipt));
    expect(Object.keys(sent).sort()).toEqual(Object.keys(expected).sort());
    for (const file of Object.keys(expected)) {
      expect({
        file,
        same: Buffer.from(sent[file]).equals(expected[file]),
      }).toEqual({ file, same: true });
    }
    expect(strFromU8(sent['README.txt'])).toContain('ORG timestamp receipt');
  });
});
