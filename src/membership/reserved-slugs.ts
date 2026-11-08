import { SLUG_PATTERN } from '../social/schemas/social-profile.schema';

/**
 * Addresses a member page may not take when someone joins. Applies only to
 * joining: the importer brings existing pages in under the addresses they
 * already have. Member pages live at the site root
 * (`orgspirituality.org/some-name`, owner, Q01), so a slug must never shadow an
 * existing or planned page of the website.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'about',
  'admin',
  'administrator',
  'api',
  'archive',
  'assets',
  'beliefs',
  'callback',
  'cart',
  'checkout',
  'community',
  'contact',
  'directory',
  'donations',
  'eam',
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
  'moderator',
  'offerings',
  'official',
  'org',
  'orders',
  'privacy',
  'profile',
  'renan',
  'research',
  'search',
  'settings',
  'sign-in',
  'sign-up',
  'signin',
  'signup',
  'static',
  'terms',
  // The two admins' own names: a look-alike address here would pass for them.
  'tripp',
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
