import { SLUG_PATTERN } from '../social/schemas/social-profile.schema';

/**
 * Addresses a member page may not take. Member pages live at the site root
 * (`orgspirituality.org/tripp`, Tripp, Q01), so a slug must never shadow an
 * existing or planned page of the website.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'about',
  'admin',
  'api',
  'archive',
  'assets',
  'beliefs',
  'callback',
  'community',
  'contact',
  'donations',
  'future',
  'future-ideas',
  'gifts-contributions',
  'guest',
  'help',
  'index',
  'infrastructure',
  'join',
  'legal',
  'login',
  'logout',
  'members',
  'membership',
  'offerings',
  'org',
  'orders',
  'privacy',
  'profile',
  'research',
  'search',
  'settings',
  'sign-in',
  'sign-up',
  'signin',
  'signup',
  'static',
  'terms',
  'tripp-org',
]);

export type SlugProblem = 'format' | 'reserved';

/**
 * Checks a proposed page address.
 *
 * @param slug - already lower-cased by the caller
 * @returns why it cannot be used, or undefined when it can
 */
export function slugProblem(slug: string): SlugProblem | undefined {
  if (slug.length < 2 || slug.length > 80 || !SLUG_PATTERN.test(slug)) {
    return 'format';
  }
  return RESERVED_SLUGS.has(slug) ? 'reserved' : undefined;
}
