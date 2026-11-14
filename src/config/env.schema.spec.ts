import { envValidationSchema } from './env.schema';

const required = {
  MONGODB_URI: 'mongodb://localhost/test-db',
  CLERK_SECRET_KEY: 'sk_test_x',
  CLIENT_ORIGIN_URL: 'http://localhost',
  PUBLIC_APP_URL: 'http://localhost',
  PAYPAL_DONATION_URL: 'https://example.test/p',
  VENMO_DONATION_URL: 'https://example.test/v',
};

function validate(env: Record<string, string>) {
  return envValidationSchema.validate(env) as {
    error?: Error;
    value: Record<string, unknown>;
  };
}

describe('a known test database', () => {
  const TEST_URI =
    'mongodb+srv://user:pw@cluster.example/org-testing?w=majority';

  it.each([
    ['missing', {}],
    ['production', { SITE_ENV: 'production' }],
  ])('refuses to start when SITE_ENV is %s', (_case, env) => {
    const { error } = validate({ ...required, MONGODB_URI: TEST_URI, ...env });
    expect(error?.message).toContain('set SITE_ENV=test');
    expect(error?.message).not.toContain('pw@');
  });

  it('starts when SITE_ENV is test', () => {
    expect(
      validate({ ...required, MONGODB_URI: TEST_URI, SITE_ENV: 'test' }).error,
    ).toBeUndefined();
  });

  it.each([
    ['production database', 'mongodb+srv://u:p@cluster.example/test?w=1'],
    ['no database named', 'mongodb+srv://u:p@cluster.example/?w=1'],
    ['bare host', 'mongodb://localhost'],
    ['a longer name', 'mongodb://localhost/org-testing-old'],
  ])('leaves production behaviour alone: %s', (_case, MONGODB_URI) => {
    const { error, value } = validate({ ...required, MONGODB_URI });
    expect(error).toBeUndefined();
    expect(value.SITE_ENV).toBe('production');
  });
});

describe('environment safety defaults', () => {
  it('treats an unset site as production, so nothing test-only can show', () => {
    expect(validate(required).value.SITE_ENV).toBe('production');
  });

  it('trusts exactly one proxy hop when unset (Render, Heroku)', () => {
    expect(validate(required).value.TRUST_PROXY_HOPS).toBe(1);
  });

  it('only checks indexes when unset, never creates them', () => {
    expect(validate(required).value.MANAGE_INDEXES).toBe('check');
  });

  it('refuses a missing required value and an unknown index mode', () => {
    expect(validate({}).error).toBeDefined();
    expect(
      validate({ ...required, MANAGE_INDEXES: 'drop' }).error,
    ).toBeDefined();
    expect(
      validate({ ...required, TRUST_PROXY_HOPS: '99' }).error,
    ).toBeDefined();
  });
});

describe('member notifications (Chunk 14)', () => {
  it('gives each site its own share of the shared daily email limit', () => {
    expect(validate(required).value).toMatchObject({
      EMAIL_DAILY_LIMIT: 70,
      EMAIL_IMMEDIATE_RESERVE: 20,
      DIGEST_HOUR_UTC: 14,
    });
    expect(validate({ ...required, SITE_ENV: 'test' }).value).toMatchObject({
      EMAIL_DAILY_LIMIT: 20,
      EMAIL_IMMEDIATE_RESERVE: 5,
    });
    expect(
      validate({
        ...required,
        EMAIL_DAILY_LIMIT: '30',
        EMAIL_IMMEDIATE_RESERVE: '0',
        DIGEST_HOUR_UTC: '0',
        PUBLIC_API_URL: 'https://api.example.test',
        NOTIFICATION_FROM_EMAIL: 'ORG <notices@example.test>',
        NOTIFICATION_SIGNING_SECRET: 's'.repeat(32),
      }).value,
    ).toMatchObject({
      EMAIL_DAILY_LIMIT: 30,
      EMAIL_IMMEDIATE_RESERVE: 0,
      DIGEST_HOUR_UTC: 0,
    });
  });

  it('refuses a limit over the free tier, a reserve that leaves no room, a short secret, an hour that is not one', () => {
    for (const env of <Record<string, string>[]>[
      { EMAIL_DAILY_LIMIT: '101' },
      { EMAIL_DAILY_LIMIT: '10', EMAIL_IMMEDIATE_RESERVE: '10' },
      { NOTIFICATION_SIGNING_SECRET: 'short' },
      { DIGEST_HOUR_UTC: '24' },
    ]) {
      expect(validate({ ...required, ...env }).error).toBeDefined();
    }
    // A bad PUBLIC_API_URL never stops the site: logged and ignored instead.
    expect(
      validate({ ...required, PUBLIC_API_URL: 'not a url' }).error,
    ).toBeUndefined();
    expect(
      validate({
        ...required,
        EMAIL_DAILY_LIMIT: '10',
        EMAIL_IMMEDIATE_RESERVE: '10',
      }).error?.message,
    ).toContain('EMAIL_IMMEDIATE_RESERVE must be below EMAIL_DAILY_LIMIT');
  });
});

describe('timestamp anchoring settings (Chunk 16)', () => {
  it('defaults to on, at 03:00 UTC, with FreeTSA and the four public calendars', () => {
    const { value } = validate(required);
    expect(value).toMatchObject({
      ANCHORING_ENABLED: true,
      ANCHOR_HOUR_UTC: 3,
      FREETSA_URL: 'https://freetsa.org/tsr',
      OTS_CALENDARS:
        'https://a.pool.opentimestamps.org,https://b.pool.opentimestamps.org,https://a.pool.eternitywall.com,https://ots.btc.catallaxy.com',
      ANCHOR_HTTP_TIMEOUT_MS: 20_000,
    });
  });

  it('can be switched off', () => {
    expect(
      validate({ ...required, ANCHORING_ENABLED: 'false' }).value
        .ANCHORING_ENABLED,
    ).toBe(false);
  });

  it.each([
    ['an http TSA', { FREETSA_URL: 'http://freetsa.org/tsr' }],
    ['an hour out of range', { ANCHOR_HOUR_UTC: '24' }],
    ['a timeout too short', { ANCHOR_HTTP_TIMEOUT_MS: '10' }],
    [
      'an http calendar',
      { OTS_CALENDARS: 'https://a.example.test,http://b.example.test' },
    ],
    ['a calendar that is not an address', { OTS_CALENDARS: 'not a url' }],
    ['no calendar at all', { OTS_CALENDARS: ' , ' }],
  ])('refuses %s', (_case, env) => {
    expect(validate({ ...required, ...env }).error).toBeDefined();
  });

  it('accepts a list of https calendars', () => {
    expect(
      validate({
        ...required,
        OTS_CALENDARS: 'https://a.example.test, https://b.example.test/',
      }).error,
    ).toBeUndefined();
  });
});
