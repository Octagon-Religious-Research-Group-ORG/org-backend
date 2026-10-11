import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureHttpApp } from './http-app';

describe('configureHttpApp', () => {
  it('trusts the configured proxy hops and applies the shared HTTP setup', () => {
    const app = {
      set: jest.fn(),
      setGlobalPrefix: jest.fn(),
      use: jest.fn(),
      enableCors: jest.fn(),
      useGlobalPipes: jest.fn(),
    };

    configureHttpApp(app as unknown as NestExpressApplication, {
      origins: ['https://example.test'],
      trustProxyHops: 1,
    });

    expect(app.set).toHaveBeenCalledWith('trust proxy', 1);
    expect(app.setGlobalPrefix).toHaveBeenCalledWith('api/v1');
    expect(app.use).toHaveBeenCalledTimes(1);
    expect(app.enableCors).toHaveBeenCalledWith(
      expect.objectContaining({ origin: ['https://example.test'] }),
    );
    expect(app.useGlobalPipes).toHaveBeenCalledWith(expect.any(ValidationPipe));
  });
});
