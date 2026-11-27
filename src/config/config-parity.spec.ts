// NestJS 12 parity (plan 2026-11-27, chunk 6): @nestjs/config 12 validates the
// schema through Standard Schema instead of calling Joi's `validate` with
// { abortEarly: false, allowUnknown: true } as version 11 did. Every value the
// app reads through ConfigService must stay exactly what Joi gives (same value,
// same type: a port stays a number, a flag a boolean), and every bad
// environment must still refuse to start, with Joi's own message.
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { envValidationSchema } from './env.schema';

const REQUIRED = {
  MONGODB_URI: 'mongodb://127.0.0.1:27017/org-website',
  CLERK_SECRET_KEY: 'sk_test_synthetic',
  CLIENT_ORIGIN_URL: 'https://org.example.test',
  PUBLIC_APP_URL: 'https://org.example.test',
  PAYPAL_DONATION_URL: 'https://paypal.example.test/give',
  VENMO_DONATION_URL: 'https://venmo.example.test/give',
};

/** Every variable the schema declares, as Joi reports them. */
const DECLARED = Object.keys(
  (envValidationSchema.describe() as { keys: Record<string, unknown> }).keys,
);

/** What version 11 served: Joi's own result, with v11's options. */
function joiResult(env: Record<string, string>) {
  return envValidationSchema.validate(env, {
    abortEarly: false,
    allowUnknown: true,
  });
}

/**
 * What the installed version serves: the real ConfigModule, reading this
 * process.env and nothing else. Every value is read while the test's
 * environment is still in place (ConfigService falls back to process.env for
 * a key the schema left unset), together with what loading wrote back to
 * process.env.
 */
async function nestConfig(env: Record<string, string>, keys = DECLARED) {
  const saved = process.env;
  process.env = { ...env };
  try {
    const moduleRef = await Test.createTestingModule({
      imports: [
        await ConfigModule.forRoot({
          ignoreEnvFile: true,
          validationSchema: envValidationSchema,
        }),
      ],
    }).compile();
    const config = moduleRef.get(ConfigService);
    return {
      served: Object.fromEntries(keys.map((key) => [key, config.get(key)])),
      writtenBack: Object.fromEntries(
        keys.map((key) => [key, process.env[key]]),
      ),
    };
  } finally {
    process.env = saved;
  }
}

describe('environment configuration on NestJS 12 matches version 11', () => {
  it('declares the 35 variables the app reads', () => {
    expect(DECLARED).toHaveLength(35);
  });

  it.each([
    ['only the required variables (every default applied)', {}],
    [
      'every variable set as the text a host gives',
      {
        NODE_ENV: 'production',
        // Text that changes when converted: loading must leave it as given.
        PORT: '08080',
        DNS_SERVERS: '1.1.1.1,8.8.8.8',
        WHITE_LISTED_EMAILS: 'a@example.test,b@example.test',
        TRUST_PROXY_HOPS: '2',
        MANAGE_INDEXES: 'create',
        SITE_ENV: 'test',
        RESEND_API_KEY: 're_synthetic',
        ORDER_FROM_EMAIL: 'orders@example.com',
        ORDER_NOTIFICATION_EMAIL: 'shop@example.com',
        NOTIFICATION_FROM_EMAIL: 'ORG <noreply@example.test>',
        NOTIFICATION_SIGNING_SECRET: 'x'.repeat(40),
        PUBLIC_API_URL: 'https://api.example.test',
        EMAIL_DAILY_LIMIT: '40',
        EMAIL_IMMEDIATE_RESERVE: '7',
        DIGEST_HOUR_UTC: '9',
        SEARCH_FRAGMENT_MIN_SEARCHERS: '3',
        SEARCH_FRAGMENT_WINDOW_DAYS: '14',
        CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_synthetic',
        ANCHORING_ENABLED: 'FALSE',
        ANCHOR_HOUR_UTC: '4',
        FREETSA_URL: 'https://tsa.example.test/tsr',
        OTS_CALENDARS: 'https://a.example.test,https://b.example.test',
        ANCHOR_LOG_SIGNING_KEY: 'signing',
        ANCHOR_LOG_VERIFIER_KEY: 'verifier',
        ANCHOR_LOG_BOOTSTRAP: '1',
        ANCHOR_LOG_ORIGIN: 'example.test/anchors/v1',
        ANCHOR_LOG_PUBLISHED_URL: 'https://example.test/checkpoint',
        ANCHOR_HTTP_TIMEOUT_MS: '15000',
      },
    ],
    [
      'optional variables set to empty text',
      {
        DNS_SERVERS: '',
        RESEND_API_KEY: '',
        ORDER_FROM_EMAIL: '',
        NOTIFICATION_SIGNING_SECRET: '',
        ANCHOR_LOG_BOOTSTRAP: '',
        ANCHOR_LOG_PUBLISHED_URL: '',
      },
    ],
  ])('serves every variable as Joi does: %s', async (_name, extra) => {
    const env = { ...REQUIRED, ...extra };
    const expected = joiResult(env);
    expect(expected.error).toBeUndefined();
    const { served, writtenBack } = await nestConfig(env);
    for (const key of DECLARED) {
      const joi = (expected.value as Record<string, string | number | boolean>)[
        key
      ];
      const value: unknown = served[key];
      expect({ key, value, type: typeof value }).toEqual({
        key,
        value: joi,
        type: typeof joi,
      });
      // Code reading process.env directly (log-details.ts reads NODE_ENV)
      // sees what it saw on version 11: given values untouched, defaults
      // filled in as text.
      expect({ key, env: writtenBack[key] }).toEqual({
        key,
        env:
          key in env
            ? (env as Record<string, string>)[key]
            : joi === undefined
              ? undefined
              : String(joi),
      });
    }
  });

  it('still passes variables the schema does not declare through as they are', async () => {
    const { served } = await nestConfig(
      { ...REQUIRED, SOMETHING_ELSE: 'kept' },
      ['SOMETHING_ELSE'],
    );
    expect(served.SOMETHING_ELSE).toBe('kept');
  });

  it.each([
    ['a required variable is missing', { MONGODB_URI: undefined }],
    ['an address is not a URL', { PUBLIC_APP_URL: 'not a url' }],
    ['a number is not a number', { PORT: 'abc' }],
    ['a value is out of range', { DIGEST_HOUR_UTC: '24' }],
    [
      'the immediate reserve is not below the daily limit',
      { EMAIL_DAILY_LIMIT: '5', EMAIL_IMMEDIATE_RESERVE: '5' },
    ],
    [
      'the test database is used without the test site',
      { MONGODB_URI: 'mongodb://127.0.0.1:27017/org-testing' },
    ],
    ['a calendar is not https', { OTS_CALENDARS: 'http://a.example.test' }],
    [
      'several things are wrong at once',
      { MONGODB_URI: undefined, PORT: 'abc', PUBLIC_APP_URL: 'not a url' },
    ],
  ])(
    'refuses to start, naming every problem, when %s',
    async (_name, change) => {
      const env = Object.fromEntries(
        Object.entries({ ...REQUIRED, ...change }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const expected = joiResult(env);
      expect(expected.error).toBeDefined();
      // Every one of Joi's problems is in the message. The layout differs and
      // nothing parses it: version 11 joins them with ". ", version 12 puts
      // each on its own line after its variable's name.
      const thrown = await nestConfig(env).then(
        () => '',
        (error: Error) => error.message,
      );
      expect(thrown).toMatch(/^Config validation error: /);
      for (const { message } of expected.error!.details) {
        expect(thrown).toContain(message);
      }
    },
  );
});
