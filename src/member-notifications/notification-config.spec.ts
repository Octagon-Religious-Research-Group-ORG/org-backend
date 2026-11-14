import { createHmac } from 'node:crypto';
import {
  BUDGET_DEFAULTS,
  DEFAULT_DIGEST_HOUR_UTC,
  readNotificationConfig,
} from './notification-config';

function config(values: Record<string, unknown>) {
  const all: Record<string, unknown> = {
    PUBLIC_APP_URL: 'https://org.example.test/',
    CLERK_SECRET_KEY: 'sk_test_synthetic',
    ...values,
  };
  return {
    get: (key: string) => all[key],
    getOrThrow: (key: string) => {
      if (all[key] === undefined) throw new Error(`missing ${key}`);
      return all[key];
    },
  } as never;
}

describe('readNotificationConfig (Chunk 14)', () => {
  it('uses the production defaults unless the site is the test site', () => {
    const production = readNotificationConfig(config({}));
    expect(production.dailyLimit).toBe(BUDGET_DEFAULTS.production.dailyLimit);
    expect(production.immediateReserve).toBe(
      BUDGET_DEFAULTS.production.immediateReserve,
    );
    expect(production.digestHourUtc).toBe(DEFAULT_DIGEST_HOUR_UTC);
    expect(production.publicAppUrl).toBe('https://org.example.test');
    expect(production.publicApiUrl).toBeUndefined();

    const test = readNotificationConfig(config({ SITE_ENV: 'test' }));
    expect(test.dailyLimit).toBe(BUDGET_DEFAULTS.test.dailyLimit);
    expect(test.immediateReserve).toBe(BUDGET_DEFAULTS.test.immediateReserve);
  });

  it('reads the configured values, numbers or strings', () => {
    const read = readNotificationConfig(
      config({
        EMAIL_DAILY_LIMIT: '40',
        EMAIL_IMMEDIATE_RESERVE: 10,
        DIGEST_HOUR_UTC: 0,
        PUBLIC_API_URL: 'https://api.example.test//',
      }),
    );
    expect(read).toMatchObject({
      dailyLimit: 40,
      immediateReserve: 10,
      digestHourUtc: 0,
      publicApiUrl: 'https://api.example.test',
    });
    // Empty or unreadable values fall back to the defaults.
    const fallback = readNotificationConfig(
      config({ EMAIL_DAILY_LIMIT: '', DIGEST_HOUR_UTC: 'soon' }),
    );
    expect(fallback.dailyLimit).toBe(BUDGET_DEFAULTS.production.dailyLimit);
    expect(fallback.digestHourUtc).toBe(DEFAULT_DIGEST_HOUR_UTC);
  });

  it('signs with the configured secret, or one derived from the Clerk key', () => {
    const own = readNotificationConfig(
      config({ NOTIFICATION_SIGNING_SECRET: 'x'.repeat(32) }),
    );
    expect(own.signingKey.equals(Buffer.from('x'.repeat(32)))).toBe(true);
    const derived = readNotificationConfig(config({}));
    expect(
      derived.signingKey.equals(
        createHmac('sha256', 'sk_test_synthetic')
          .update('org-notifications-unsubscribe-v1')
          .digest(),
      ),
    ).toBe(true);
    // Never the Clerk key itself.
    expect(derived.signingKey.toString('utf8')).not.toContain('sk_test');
  });
});
