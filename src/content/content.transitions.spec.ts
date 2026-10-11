import { ConflictException, NotFoundException } from '@nestjs/common';
import type { StoredWebsitePage } from './content.models';
import {
  assertHistoricalRevision,
  createDraft,
  createPublication,
  createRestoredDraft,
} from './content.transitions';
import type { ReferencePageContent } from './content.types';

const content: ReferencePageContent = {
  kind: 'reference',
  id: 'community',
  title: 'Community',
  subtitle: 'Community subtitle',
  blocks: [],
};

function pageFixture(): StoredWebsitePage {
  return {
    pageId: 'community',
    published: {
      revision: 3,
      content,
      publishedAt: new Date('2026-07-20T00:00:00.000Z'),
      publishedBy: 'user_publisher',
    },
    draft: {
      revision: 2,
      basedOnPublishedRevision: 3,
      content: { ...content, title: 'Edited community' },
      updatedAt: new Date('2026-07-21T00:00:00.000Z'),
      updatedBy: 'user_editor',
    },
    history: Array.from({ length: 10 }, (_, index) => ({
      revision: 2 - index,
      content: { ...content, title: `Community revision ${2 - index}` },
      publishedAt: new Date('2026-07-19T00:00:00.000Z'),
      publishedBy: 'user_publisher',
    })),
  };
}

describe('content transitions', () => {
  it('creates the next draft against the current publication', () => {
    const page = pageFixture();
    page.draft = null;
    const updatedAt = new Date('2026-07-23T00:00:00.000Z');

    const draft = createDraft(
      page,
      null,
      { ...content, title: 'Next title' },
      'user_editor',
      updatedAt,
    );

    expect(draft).toEqual({
      revision: 1,
      basedOnPublishedRevision: 3,
      content: { ...content, title: 'Next title' },
      updatedAt,
      updatedBy: 'user_editor',
    });
  });

  it('publishes the expected draft and retains ten revisions', () => {
    const page = pageFixture();
    const publishedAt = new Date('2026-07-23T00:00:00.000Z');

    const transition = createPublication(
      page,
      2,
      'user_publisher',
      publishedAt,
    );

    expect(transition.published).toEqual({
      revision: 4,
      content: page.draft?.content,
      publishedAt,
      publishedBy: 'user_publisher',
    });
    expect(transition.history).toHaveLength(10);
    expect(transition.history[0]).toBe(page.published);
  });

  it('rejects a stale draft before making a transition', () => {
    expect(() =>
      createDraft(pageFixture(), 1, content, 'user_editor', new Date()),
    ).toThrow(ConflictException);
  });

  it('requires a saved draft before publishing', () => {
    const page = pageFixture();
    page.draft = null;

    expect(() =>
      createPublication(page, null, 'user_publisher', new Date()),
    ).toThrow(ConflictException);
  });

  it('rejects a draft based on an older publication', () => {
    const page = pageFixture();
    page.draft!.basedOnPublishedRevision = 2;

    expect(() =>
      createPublication(page, 2, 'user_publisher', new Date()),
    ).toThrow(ConflictException);
  });

  it('publishes when historical revisions have not been initialized', () => {
    const page = pageFixture();
    page.history = undefined;

    expect(
      createPublication(page, 2, 'user_publisher', new Date()).history,
    ).toEqual([page.published]);
  });

  it('restores archived content as a new draft', () => {
    const page = pageFixture();
    const source = page.history?.[1];
    const updatedAt = new Date('2026-07-23T00:00:00.000Z');

    const draft = createRestoredDraft(
      page,
      source!.revision,
      2,
      'user_restorer',
      updatedAt,
    );

    expect(draft).toEqual({
      revision: 3,
      basedOnPublishedRevision: 3,
      content: source!.content,
      updatedAt,
      updatedBy: 'user_restorer',
    });
  });

  it('rejects invalid or missing historical revisions', () => {
    expect(() => assertHistoricalRevision(0)).toThrow(NotFoundException);
    expect(() =>
      createRestoredDraft(pageFixture(), 999, 2, 'user_restorer', new Date()),
    ).toThrow(NotFoundException);
  });
});
