import * as Joi from 'joi';
import { IMPORT_TEST_DATABASES } from '../import/import-guard';
import { SITE_ENVS } from './site-env';

/** The database a MongoDB connection string names, or undefined. */
function databaseOf(uri: string): string | undefined {
  return /^mongodb(?:\+srv)?:\/\/[^/?]+\/([^/?]+)/.exec(uri)?.[1];
}

/**
 * Refuses to start on a known test database unless SITE_ENV says test.
 *
 * SITE_ENV fails open: removing it from the test server would quietly restore
 * real payment links. The database name is the one signal a backend has, and
 * production is unaffected because its database is not on the exact list. The
 * message never repeats the connection string.
 */
const requireTestSiteOnTestDatabase: Joi.CustomValidator<{
  MONGODB_URI: string;
  SITE_ENV: string;
}> = (env, helpers) => {
  const database = databaseOf(env.MONGODB_URI);
  if (
    database !== undefined &&
    IMPORT_TEST_DATABASES.includes(database) &&
    env.SITE_ENV !== 'test'
  ) {
    return helpers.message({
      custom: `Database "${database}" is a test database: set SITE_ENV=test.`,
    });
  }
  return env;
};

/**
 * Environment the app starts with. Its own module so the safety defaults can
 * be tested: an unset SITE_ENV must mean production, an unset MANAGE_INDEXES
 * must never write indexes, and an unset hop count must match the platforms.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3001),
  MONGODB_URI: Joi.string().required(),
  DNS_SERVERS: Joi.string().allow('').optional(),
  CLERK_SECRET_KEY: Joi.string().required(),
  WHITE_LISTED_EMAILS: Joi.string().allow('').default(''),
  CLIENT_ORIGIN_URL: Joi.string().required(),
  PUBLIC_APP_URL: Joi.string().uri().required(),
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).max(5).default(1),
  MANAGE_INDEXES: Joi.string().valid('check', 'create').default('check'),
  SITE_ENV: Joi.string()
    .valid(...SITE_ENVS)
    .default('production'),
  PAYPAL_DONATION_URL: Joi.string().uri().required(),
  VENMO_DONATION_URL: Joi.string().uri().required(),
  RESEND_API_KEY: Joi.string().allow('').optional(),
  ORDER_FROM_EMAIL: Joi.string().email().allow('').optional(),
  ORDER_NOTIFICATION_EMAIL: Joi.string().email().allow('').optional(),
}).custom(requireTestSiteOnTestDatabase);
