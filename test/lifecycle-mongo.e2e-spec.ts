/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
// The whole app's start and clean close against a REAL MongoDB (NestJS 12
// plan, chunk 8). A regression guard: every scheduler must start, must have a
// stop hook that runs on close (it clears its timer), and the connection must
// end closed. Nest itself runs every onModuleDestroy before any
// onApplicationShutdown (where Mongo closes), so this does not test NestJS
// 12's module-level ordering; the full recorded order was compared by hand
// (identical shutdown on 11 and 12). Known, unchanged on both versions: a
// scheduler run already in flight is not awaited on close.
// Needs MONGO_TEST_URI (a throwaway database). Without it the suite is
// reported as SKIPPED, never as passed.
import type { INestApplication } from '@nestjs/common';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type { AppModule as AppModuleType } from '../src/app.module';

const uri = process.env.MONGO_TEST_URI;
const describeWithMongo = uri ? describe : describe.skip;
jest.setTimeout(120_000);

const HOOKS = [
  'onModuleInit',
  'onApplicationBootstrap',
  'onModuleDestroy',
  'beforeApplicationShutdown',
  'onApplicationShutdown',
] as const;

const SCHEDULERS = [
  'AnchorScheduler',
  'ConnectionExpiryScheduler',
  'MemberPurgeScheduler',
  'NotificationDispatcher',
];

describeWithMongo(
  'the app starts and closes in order, on a real MongoDB',
  () => {
    const saved = process.env;
    let app: INestApplication;
    const order: string[] = [];

    beforeAll(async () => {
      process.env = {
        ...saved,
        MONGODB_URI: String(uri),
        SITE_ENV: 'test',
        CLERK_SECRET_KEY: 'sk_test_synthetic',
        CLIENT_ORIGIN_URL: 'http://localhost:3000',
        PUBLIC_APP_URL: 'http://localhost:3000',
        PAYPAL_DONATION_URL: 'https://example.com/give',
        VENMO_DONATION_URL: 'https://example.com/give',
      };
      // Loaded only now: the config module reads the environment as soon as
      // AppModule is loaded.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AppModule } = require('../src/app.module') as {
        AppModule: typeof AppModuleType;
      };
      app = await NestFactory.create(AppModule, { logger: false });
      const wrapped = new Set<object>();
      for (const mod of app.get(ModulesContainer).values()) {
        for (const map of [mod.providers, mod.controllers, mod.injectables]) {
          for (const wrapper of map.values()) {
            const instance = wrapper.instance as
              Record<string, any> | undefined;
            if (!instance || typeof instance !== 'object') continue;
            if (wrapped.has(instance)) continue;
            wrapped.add(instance);
            for (const hook of HOOKS) {
              if (typeof instance[hook] !== 'function') continue;
              const original = instance[hook].bind(instance);
              instance[hook] = (...args: unknown[]) => {
                order.push(`${hook} ${instance.constructor.name}`);
                return original(...args);
              };
            }
          }
        }
      }
      const connection = app.get<Connection>(getConnectionToken());
      const close = connection.close.bind(connection);
      connection.close = ((...args: Parameters<Connection['close']>) => {
        order.push('mongo close');
        return close(...args);
      }) as Connection['close'];
      await app.init();
      order.push('started');
    });

    let appClosed = false;
    afterAll(async () => {
      // Never leave the app and its connection open, even after a failure.
      if (app && !appClosed) await app.close();
      process.env = saved;
    });

    it('starts every scheduler, then on close runs each stop hook before the database connection closes', async () => {
      for (const name of SCHEDULERS) {
        expect(order).toContain(`onApplicationBootstrap ${name}`);
      }
      const connection = app.get<Connection>(getConnectionToken());
      appClosed = true;
      await app.close();
      const closed = order.indexOf('mongo close');
      expect(closed).toBeGreaterThan(order.indexOf('started'));
      for (const name of SCHEDULERS) {
        const stopped = order.indexOf(`onModuleDestroy ${name}`);
        expect({ name, stopped: stopped > order.indexOf('started') }).toEqual({
          name,
          stopped: true,
        });
        expect({ name, beforeMongo: stopped < closed }).toEqual({
          name,
          beforeMongo: true,
        });
      }
      // 0 = disconnected.
      expect(connection.readyState).toBe(0);
    });
  },
);
