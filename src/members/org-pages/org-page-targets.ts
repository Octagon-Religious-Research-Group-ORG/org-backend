import {
  WEBSITE_PAGE_IDS,
  type WebsitePageId,
} from '../../content/content.types';

/**
 * ORG's own pages as a vote and comment target (Chunk 10b, plan §2b: the five
 * buttons "on every belief and on ORG's own pages").
 *
 * Votes, vote history, tallies and comments are all keyed by a thread id
 * (`tabId`). A belief's is `tab_<uuid>`; an ORG page's is this prefix plus
 * its page id, e.g. `org-page:about`. The colon can never appear in a belief
 * tab id (nor pass the API's id pattern), so the two kinds never meet, and
 * every existing row stays exactly as it is: no field was added and no hash
 * changes (the vote chain already commits to the `tabId`).
 *
 * The rows' `profileId` is the ORG page's own database id.
 */
export const ORG_PAGE_THREAD_PREFIX = 'org-page:';

/** `tabId` filter for anything that must leave ORG pages out. */
export const NOT_AN_ORG_PAGE = { $not: /^org-page:/ };

export function isOrgPageId(value: string): value is WebsitePageId {
  return (WEBSITE_PAGE_IDS as readonly string[]).includes(value);
}

/** The thread id of an ORG page. */
export function orgPageThreadId(pageId: WebsitePageId): string {
  return `${ORG_PAGE_THREAD_PREFIX}${pageId}`;
}

/** The ORG page a thread id names, or undefined for a belief or no thread. */
export function orgPageIdOfThread(
  tabId: string | undefined,
): string | undefined {
  return tabId?.startsWith(ORG_PAGE_THREAD_PREFIX)
    ? tabId.slice(ORG_PAGE_THREAD_PREFIX.length)
    : undefined;
}
