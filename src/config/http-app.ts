import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import helmet from 'helmet';
import { MAX_JOIN_BODY_BYTES } from '../membership/membership.dto';
import { createCorsOptions } from './cors';

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
  app.use('/api/v1/me/membership', (request, response, next) =>
    parseLongJoin(request, response, next),
  );
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
}
