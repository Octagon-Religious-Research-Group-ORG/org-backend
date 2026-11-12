import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Readable } from 'node:stream';
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
    for (const route of ['/api/v1/me/membership', '/api/v1/me/member-page']) {
      const [, parser] = app.use.mock.calls.find(
        ([path]) => path === route,
      ) as [string, (req: unknown, res: unknown, next: () => void) => void];
      expect(parser.name).not.toBe('jsonParser');
      const next = jest.fn();
      parser({ headers: {} }, {}, next);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it('gives the larger edit limit only to a request with a bearer token', async () => {
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
      ([path]) => path === '/api/v1/me/member-page',
    ) as [string, (req: unknown, res: unknown, next: () => void) => void];
    // Without a token the request is passed on untouched, its body unread.
    const jsonRequest = (authorization?: string) =>
      Object.assign(Readable.from(['{"a":1}']), {
        headers: {
          authorization,
          'content-type': 'application/json',
          'content-length': '7',
        },
        body: undefined,
      });
    for (const authorization of [undefined, '', 'Basic abc', 'Bearer ']) {
      const request = jsonRequest(authorization);
      await new Promise<void>((resolve) => parser(request, {}, resolve));
      expect(request.body).toBeUndefined();
    }
    // With one, the JSON parser reads the body.
    const withToken = jsonRequest('Bearer token');
    await new Promise<void>((resolve) => parser(withToken, {}, resolve));
    expect(withToken.body).toEqual({ a: 1 });
    for (const authorization of ['bearer x', 'Bearer  x', 'BEARER\tx']) {
      const request = jsonRequest(authorization);
      await new Promise<void>((resolve) => parser(request, {}, resolve));
      expect(request.body).toEqual({ a: 1 });
    }
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
    expect(app.use).toHaveBeenCalledTimes(4);
    for (const path of [
      '/api/v1/me/membership',
      '/api/v1/me/member-page',
      '/api/v1/me/suggestions',
    ]) {
      expect(app.use).toHaveBeenCalledWith(path, expect.any(Function));
    }
    expect(app.enableCors).toHaveBeenCalledWith(
      expect.objectContaining({ origin: ['https://example.test'] }),
    );
    expect(app.useGlobalPipes).toHaveBeenCalledWith(expect.any(ValidationPipe));
  });
});
