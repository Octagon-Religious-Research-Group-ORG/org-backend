import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureHttpApp } from './http-app';

describe('configureHttpApp', () => {
  it('parses long join requests with a middleware Nest will not mistake for its own', () => {
    const app = {
      set: jest.fn(),
      setGlobalPrefix: jest.fn(),
      use: jest.fn(),
      enableCors: jest.fn(),
      useGlobalPipes: jest.fn(),
    };
    configureHttpApp(app as unknown as NestExpressApplication, {
      origins: [],
      trustProxyHops: 1,
    });
    const [, parser] = app.use.mock.calls.find(
      ([path]) => path === '/api/v1/me/membership',
    ) as [string, (req: unknown, res: unknown, next: () => void) => void];
    expect(parser.name).not.toBe('jsonParser');
    const next = jest.fn();
    parser({ headers: {} }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

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
    expect(app.use).toHaveBeenCalledTimes(2);
    expect(app.use).toHaveBeenCalledWith(
      '/api/v1/me/membership',
      expect.any(Function),
    );
    expect(app.enableCors).toHaveBeenCalledWith(
      expect.objectContaining({ origin: ['https://example.test'] }),
    );
    expect(app.useGlobalPipes).toHaveBeenCalledWith(expect.any(ValidationPipe));
  });
});
