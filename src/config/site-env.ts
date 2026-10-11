import type { ConfigService } from '@nestjs/config';

/**
 * Which site this backend serves. `test` is the permanent test environment
 * (org-backend-testing on Render): it must never send anyone to ORG's real
 * payment accounts, and every email it sends says it came from the test site.
 */
export type SiteEnv = 'production' | 'test';

export const SITE_ENVS: readonly SiteEnv[] = ['production', 'test'];

/** Prefixed to every email subject sent by the test site. */
export const TEST_SITE_SUBJECT_PREFIX = '[TEST SITE] ';

/** First line of every email body sent by the test site. */
export const TEST_SITE_EMAIL_NOTICE =
  'This message comes from the ORG TEST site. Nothing here is a real request, and no money should be sent.';

/**
 * Reads `SITE_ENV`. Only the exact value `test` selects the test site, so a
 * missing or mistyped value behaves like production (Joi rejects mistypes at
 * startup anyway).
 */
export function readSiteEnv(config: Pick<ConfigService, 'get'>): SiteEnv {
  return config.get<string>('SITE_ENV') === 'test' ? 'test' : 'production';
}
