import * as Joi from 'joi';
import { IMPORT_TEST_DATABASES } from '../import/import-guard';
import {
  BUDGET_DEFAULTS,
  DEFAULT_DIGEST_HOUR_UTC,
} from '../member-notifications/notification-config';
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

/** The immediate reserve must leave room for digests (Chunk 14). */
const requireReserveBelowLimit: Joi.CustomValidator<{
  EMAIL_DAILY_LIMIT: number;
  EMAIL_IMMEDIATE_RESERVE: number;
}> = (env, helpers) =>
  env.EMAIL_IMMEDIATE_RESERVE < env.EMAIL_DAILY_LIMIT
    ? env
    : helpers.message({
        custom: 'EMAIL_IMMEDIATE_RESERVE must be below EMAIL_DAILY_LIMIT.',
      });

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
  // Member notifications (Chunk 14). The sender falls back to
  // ORDER_FROM_EMAIL; may carry a name ("ORG <notices@...>").
  NOTIFICATION_FROM_EMAIL: Joi.string().allow('').optional(),
  // Signs unsubscribe links; derived from CLERK_SECRET_KEY when unset.
  NOTIFICATION_SIGNING_SECRET: Joi.string().min(32).allow('').optional(),
  // This backend's public address, for one-click unsubscribe headers. Any
  // form is read (with or without "/api/v1"); a bad one is logged and
  // ignored at start-up rather than stopping the site (review L11).
  PUBLIC_API_URL: Joi.string().allow('').optional(),
  // The shared Resend free tier is 100 a day for BOTH sites: each site's
  // share, and how much of it is kept for immediate emails.
  EMAIL_DAILY_LIMIT: Joi.number()
    .integer()
    .min(1)
    .max(100)
    .when('SITE_ENV', {
      is: 'test',
      then: Joi.number().default(BUDGET_DEFAULTS.test.dailyLimit),
      otherwise: Joi.number().default(BUDGET_DEFAULTS.production.dailyLimit),
    }),
  EMAIL_IMMEDIATE_RESERVE: Joi.number()
    .integer()
    .min(0)
    .max(99)
    .when('SITE_ENV', {
      is: 'test',
      then: Joi.number().default(BUDGET_DEFAULTS.test.immediateReserve),
      otherwise: Joi.number().default(
        BUDGET_DEFAULTS.production.immediateReserve,
      ),
    }),
  DIGEST_HOUR_UTC: Joi.number()
    .integer()
    .min(0)
    .max(23)
    .default(DEFAULT_DIGEST_HOUR_UTC),
})
  .custom(requireTestSiteOnTestDatabase)
  .custom(requireReserveBelowLimit);
