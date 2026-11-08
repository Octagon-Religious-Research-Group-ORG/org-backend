import type { PublishedWebsitePage, WebsitePageContent } from './content.types';

/** Shown on the test site wherever a real payment account would be. */
export const TEST_SITE_PAYMENT_PLACEHOLDER = '(test site: no real payment)';

const PAYMENT_LINK =
  /(?<![\p{L}\p{N}.@-])(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:paypal\.(?:me|com(?:\.[a-z]{2})?)|venmo\.(?:com|me)|cash\.(?:app|me))(?![\p{L}\p{N}-])(?:\/\S*)?/giu;

/** ORG's real accounts: never shown on the test site, on any page. */
const KNOWN_HANDLES = /[$@＠](?:trippaardema|the_org)(?![\p{L}\p{N}_])/giu;

/**
 * `$name` or `@name` not inside a longer word, so an email address is left
 * alone. A `$` must be followed by a letter: `$60` is a price.
 */
const PAYMENT_HANDLE =
  /(?<![\p{L}\p{N}_.])(?:\$[\p{L}_]|[@＠][\p{L}\p{N}_])[\p{L}\p{N}_]*(?:[.-][\p{L}\p{N}_]+)*/gu;

function clean(value: unknown, isDonationsPage: boolean): unknown {
  if (typeof value === 'string') {
    const safe = value
      .replace(PAYMENT_LINK, TEST_SITE_PAYMENT_PLACEHOLDER)
      .replace(KNOWN_HANDLES, TEST_SITE_PAYMENT_PLACEHOLDER);
    return isDonationsPage
      ? safe.replace(PAYMENT_HANDLE, TEST_SITE_PAYMENT_PLACEHOLDER)
      : safe;
  }
  if (Array.isArray(value)) {
    return value.map((item) => clean(item, isDonationsPage));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        clean(item, isDonationsPage),
      ]),
    );
  }
  return value;
}

/**
 * A published page as the test site may show it, with no real payment account
 * in it. Applied when the page is served rather than when it is seeded, so it
 * also covers rows already in the database and later edits in the CMS.
 *
 * Unknown handles are only replaced on the donations page: other pages
 * legitimately show `@` handles, such as the Telegram contacts.
 *
 * @param page - the page as stored
 * @returns a copy that is safe to show on the test site
 */
export function withoutRealPayments(
  page: PublishedWebsitePage,
): PublishedWebsitePage {
  return {
    ...page,
    content: clean(
      page.content,
      page.pageId === 'donations',
    ) as WebsitePageContent,
  };
}
