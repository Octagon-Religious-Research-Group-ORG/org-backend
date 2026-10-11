import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
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
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
}
