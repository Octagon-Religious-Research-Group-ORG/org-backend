import type { StoredWebsitePage } from './content.models';
import {
  toAdminWebsitePage,
  toPublicWebsitePage,
  toWebsitePageSummary,
} from './content.presenters';
import { INITIAL_WEBSITE_PAGES } from './initial-content';

const page: StoredWebsitePage = {
  pageId: 'community',
  published: {
    revision: 3,
    content: INITIAL_WEBSITE_PAGES[1],
    publishedAt: new Date('2026-07-20T00:00:00.000Z'),
    publishedBy: 'user_publisher',
  },
  draft: {
    revision: 4,
    basedOnPublishedRevision: 3,
    content: INITIAL_WEBSITE_PAGES[1],
    updatedAt: '2026-07-21T00:00:00.000Z',
    updatedBy: 'user_editor',
  },
  history: [
    {
      revision: 2,
      content: INITIAL_WEBSITE_PAGES[1],
      publishedAt: '2026-07-19T00:00:00.000Z',
      publishedBy: 'user_publisher',
    },
  ],
};

describe('content presenters', () => {
  it('shapes the public response and serializes dates', () => {
    expect(toPublicWebsitePage(page)).toEqual({
      pageId: 'community',
      revision: 3,
      content: INITIAL_WEBSITE_PAGES[1],
      publishedAt: '2026-07-20T00:00:00.000Z',
    });
  });

  it('uses the latest draft update in the page summary', () => {
    expect(toWebsitePageSummary(page)).toEqual({
      pageId: 'community',
      title: INITIAL_WEBSITE_PAGES[1].title,
      publishedRevision: 3,
      draftRevision: 4,
      updatedAt: '2026-07-21T00:00:00.000Z',
    });
  });

  it('shapes draft and history records for the admin response', () => {
    const response = toAdminWebsitePage(page);

    expect(response.published.publishedAt).toBe('2026-07-20T00:00:00.000Z');
    expect(response.draft).toMatchObject({
      revision: 4,
      updatedAt: '2026-07-21T00:00:00.000Z',
    });
    expect(response.history).toHaveLength(1);
    expect(response.history[0].publishedAt).toBe('2026-07-19T00:00:00.000Z');
  });

  it('uses publication metadata when draft and history are absent', () => {
    const publishedOnly = {
      ...page,
      draft: null,
      history: undefined,
    };

    expect(toWebsitePageSummary(publishedOnly)).toMatchObject({
      draftRevision: null,
      updatedAt: '2026-07-20T00:00:00.000Z',
    });
    expect(toAdminWebsitePage(publishedOnly)).toMatchObject({
      draft: null,
      history: [],
    });
  });
});
