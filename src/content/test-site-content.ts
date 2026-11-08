import type { PublishedWebsitePage, WebsitePageContent } from './content.types';

/** Shown on the test site wherever a real payment account would be. */
export const TEST_SITE_PAYMENT_PLACEHOLDER = '(test site: no real payment)';

const PAYMENT_LINK =
  /(?:https?:\/\/)?(?:www\.)?(?:paypal\.(?:me|com)|venmo\.com|cash\.app)(?:\/\S*)?/gi;

/** `$name` or `@name` as a whole word, so an email address is left alone. */
const PAYMENT_HANDLE = /(^|\s)[$@][\p{L}\p{N}_.-]+/gu;

function clean(value: unknown, isDonationsPage: boolean): unknown {
  if (typeof value === 'string') {
    const unlinked = value.replace(PAYMENT_LINK, TEST_SITE_PAYMENT_PLACEHOLDER);
    return isDonationsPage
      ? unlinked.replace(PAYMENT_HANDLE, `$1${TEST_SITE_PAYMENT_PLACEHOLDER}`)
      : unlinked;
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
 * Handles are only replaced on the donations page: other pages legitimately
 * show `@` handles, such as the Telegram contacts.
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
