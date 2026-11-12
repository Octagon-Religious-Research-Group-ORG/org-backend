import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { MAX_SUGGESTION_BODY_BYTES } from '../members/comments/comments.dto';
import { MAX_EDIT_BODY_BYTES } from '../members/members.dto';
import { MAX_JOIN_BODY_BYTES } from '../membership/membership.dto';
import { createCorsOptions } from './cors';

/** As Clerk reads it: any case, one or more spaces, then a token. */
const BEARER = /^bearer\s+\S/i;

export interface HttpAppOptions {
  origins: string[];
  /**
   * Reverse-proxy hops in front of the app (Render and Heroku: 1). Express
   * then takes the client address that many hops from the right of
   * X-Forwarded-For, so `req.ip` is the real visitor and per-IP rate limits
   * stop counting every visitor as the platform's router. Never trust the
   * leftmost entry: any client can write it.
   */
  trustProxyHops: number;
}

/**
 * Applies the HTTP configuration shared by the server and the e2e suite, so
 * the tests exercise exactly what production runs.
 */
export function configureHttpApp(
  app: NestExpressApplication,
  { origins, trustProxyHops }: HttpAppOptions,
): void {
  app.set('trust proxy', trustProxyHops);
  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.enableCors(createCorsOptions(origins));
  // Only the join route accepts a long page. It parses here, first, so the
  // default 100 kB limit still applies to every other route. Wrapped because
  // Nest skips its own parser when it finds a middleware named "jsonParser",
  // which would leave every other route with no JSON parsing at all.
  const parseLongJoin = json({ limit: MAX_JOIN_BODY_BYTES });
  app.use(
    '/api/v1/me/membership',
    (request: Request, response: Response, next: NextFunction) =>
      parseLongJoin(request, response, next),
  );
  // The owner's edits may be as long as their DTO allows (Chunk 8). Only a
  // request carrying a token gets the larger limit: an anonymous one is
  // refused anyway, and keeps the default limit, so it cannot make the
  // server read a large body first.
  // A rewording suggestion carries a whole belief too (Chunk 9).
  const longBodies: Array<[string, number]> = [
    ['/api/v1/me/member-page', MAX_EDIT_BODY_BYTES],
    ['/api/v1/me/suggestions', MAX_SUGGESTION_BODY_BYTES],
  ];
  for (const [path, limit] of longBodies) {
    const parseLong = json({ limit });
    app.use(
      path,
      (request: Request, response: Response, next: NextFunction) => {
        if (!BEARER.test(request.headers.authorization ?? '')) {
          next();
          return;
        }
        parseLong(request, response, next);
      },
    );
  }
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
}
