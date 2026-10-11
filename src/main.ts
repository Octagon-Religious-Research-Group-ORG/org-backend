import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureHttpApp } from './config/http-app';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);
  const origins = config
    .getOrThrow<string>('CLIENT_ORIGIN_URL')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  configureHttpApp(app, {
    origins,
    trustProxyHops: config.get<number>('TRUST_PROXY_HOPS', 1),
  });
  app.enableShutdownHooks();

  await app.listen(config.get<number>('PORT', 3001));
}
void bootstrap();
