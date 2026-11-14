import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';

/** Defaults for the daily email budget, per site (both share one account). */
export const BUDGET_DEFAULTS = {
  production: { dailyLimit: 70, immediateReserve: 20 },
  test: { dailyLimit: 20, immediateReserve: 5 },
} as const;

export const DEFAULT_DIGEST_HOUR_UTC = 14;

/** What the notification code reads from the environment, validated. */
export interface NotificationConfig {
  /** Most emails a day this backend sends for notifications. */
  dailyLimit: number;
  /** Of those, kept for immediate emails: digests stop this short. */
  immediateReserve: number;
  /** UTC hour from which the day's digests go out. */
  digestHourUtc: number;
  /** Where links in emails point (the website). */
  publicAppUrl: string;
  /** This backend's public address, for one-click unsubscribe; optional. */
  publicApiUrl?: string;
  /** Key for unsubscribe links. */
  signingKey: Buffer;
}

function numberOr(
  config: Pick<ConfigService, 'get'>,
  key: string,
  fallback: number,
) {
  const raw = config.get<number | string>(key);
  const value = Number(raw);
  return raw === undefined || raw === '' || !Number.isFinite(value)
    ? fallback
    : value;
}

/**
 * Reads the notification settings. The Joi schema has already validated and
 * defaulted them; the fallbacks here only matter in tests that pass a bare
 * config.
 *
 * The unsubscribe key is `NOTIFICATION_SIGNING_SECRET` when set, otherwise
 * derived from the Clerk secret, so the links work with no new setting (and
 * stop working, harmlessly, if that key is ever rotated).
 */
export function readNotificationConfig(
  config: Pick<ConfigService, 'get' | 'getOrThrow'>,
): NotificationConfig {
  const site =
    config.get<string>('SITE_ENV') === 'test'
      ? BUDGET_DEFAULTS.test
      : BUDGET_DEFAULTS.production;
  const secret = config.get<string>('NOTIFICATION_SIGNING_SECRET');
  const signingKey = secret
    ? Buffer.from(secret, 'utf8')
    : createHmac('sha256', config.getOrThrow<string>('CLERK_SECRET_KEY'))
        .update('org-notifications-unsubscribe-v1')
        .digest();
  const publicApiUrl = config.get<string>('PUBLIC_API_URL') || undefined;
  return {
    dailyLimit: numberOr(config, 'EMAIL_DAILY_LIMIT', site.dailyLimit),
    immediateReserve: numberOr(
      config,
      'EMAIL_IMMEDIATE_RESERVE',
      site.immediateReserve,
    ),
    digestHourUtc: numberOr(config, 'DIGEST_HOUR_UTC', DEFAULT_DIGEST_HOUR_UTC),
    publicAppUrl: config
      .getOrThrow<string>('PUBLIC_APP_URL')
      .replace(/\/+$/, ''),
    ...(publicApiUrl ? { publicApiUrl: publicApiUrl.replace(/\/+$/, '') } : {}),
    signingKey,
  };
}
