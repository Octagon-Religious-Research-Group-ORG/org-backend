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
