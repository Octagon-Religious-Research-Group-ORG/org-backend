// A real import() would need --experimental-vm-modules under this Jest setup.
import { NestFactory } from '@nestjs/core';

jest.mock('./app.module', () => ({ AppModule: class AppModule {} }));
jest.mock('@nestjs/core', () => ({ NestFactory: { create: jest.fn() } }));

describe('bootstrap', () => {
  it('passes the configured proxy hops to the HTTP setup', async () => {
    const config = {
      getOrThrow: jest.fn(() => 'https://a.example, https://b.example'),
      get: jest.fn((key: string, fallback: unknown) =>
        key === 'TRUST_PROXY_HOPS' ? 3 : fallback,
      ),
    };
    const app = {
      get: jest.fn(() => config),
      set: jest.fn(),
      setGlobalPrefix: jest.fn(),
      use: jest.fn(),
      enableCors: jest.fn(),
      useGlobalPipes: jest.fn(),
      enableShutdownHooks: jest.fn(),
      listen: jest.fn(() => Promise.resolve()),
    };
    (NestFactory.create as jest.Mock).mockResolvedValue(app);

    jest.requireActual('./main');
    await new Promise((resolve) => setImmediate(resolve));

    expect(app.set).toHaveBeenCalledWith('trust proxy', 3);
    expect(app.enableCors).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: ['https://a.example', 'https://b.example'],
      }),
    );
    expect(app.listen).toHaveBeenCalledWith(3001);
  });
});
