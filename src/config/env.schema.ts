import * as Joi from 'joi';
import { SITE_ENVS } from './site-env';

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
});
