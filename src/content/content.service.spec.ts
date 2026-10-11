/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { ConflictException } from '@nestjs/common';
import { ContentService } from './content.service';
import { INITIAL_WEBSITE_PAGES } from './initial-content';

interface MockQuery<T> {
  lean: () => MockQuery<T>;
  sort: () => MockQuery<T>;
  exec: () => Promise<T>;
}

function query<T>(value: T): MockQuery<T> {
  const result: MockQuery<T> = {
    lean: () => result,
    sort: () => result,
    exec: () => Promise.resolve(value),
  };
  return result;
}

function pageFixture() {
  const content = INITIAL_WEBSITE_PAGES[1];
  const page = {
    pageId: content.id,
    published: {
      revision: 3,
      content,
      publishedAt: new Date('2026-07-20T00:00:00.000Z'),
      publishedBy: 'user_publisher',
    },
    draft: {
      revision: 2,
      basedOnPublishedRevision: 3,
      content: {
        ...content,
        title: 'Edited community',
      },
      updatedAt: new Date('2026-07-21T00:00:00.000Z'),
      updatedBy: 'user_editor',
    },
    history: Array.from({ length: 10 }, (_, index) => ({
      revision: 2 - index,
      content,
      publishedAt: new Date('2026-07-19T00:00:00.000Z'),
      publishedBy: 'user_publisher',
    })),
  };
  return page as Omit<typeof page, 'draft'> & {
    draft?: typeof page.draft;
  };
}

describe('ContentService', () => {
  it('seeds every page with insert-only updates', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const model = {
      updateOne: jest.fn(
        (_filter: unknown, update: Record<string, unknown>) => {
          updates.push(update);
          return query(undefined);
        },
      ),
    };
    const service = new ContentService(model as never);

    await service.onApplicationBootstrap();

    expect(model.updateOne).toHaveBeenCalledTimes(8);
    for (const update of updates) {
      expect(update).toHaveProperty('$setOnInsert');
      expect(update).not.toHaveProperty('$set');
    }
  });

  it('lists and retrieves public and administrator page views', async () => {
    const current = pageFixture();
    const model = {
      find: jest
        .fn()
        .mockReturnValueOnce(query([current]))
        .mockReturnValueOnce(query([current])),
      findOne: jest
        .fn()
        .mockReturnValueOnce(query(current))
        .mockReturnValueOnce(query(current)),
    };
    const service = new ContentService(model as never);

    await expect(service.listPublic()).resolves.toEqual([
      expect.objectContaining({ pageId: current.pageId, revision: 3 }),
    ]);
    await expect(service.getPublic(current.pageId)).resolves.toMatchObject({
      pageId: current.pageId,
      revision: 3,
    });
    await expect(service.listAdmin()).resolves.toEqual([
      expect.objectContaining({ pageId: current.pageId, draftRevision: 2 }),
    ]);
    await expect(service.getAdmin(current.pageId)).resolves.toMatchObject({
      pageId: current.pageId,
      draft: expect.objectContaining({ revision: 2 }),
    });
  });

  it('rejects a page that is valid but missing from storage', async () => {
    const model = { findOne: jest.fn(() => query(null)) };
    const service = new ContentService(model as never);

    await expect(service.getPublic('community')).rejects.toThrow(
      'That website page does not exist.',
    );
  });

  it.each([
    ['new', null],
    ['existing', 2],
  ])(
    'saves a %s draft using optimistic revision matching',
    async (_name, expected) => {
      const current = pageFixture();
      if (expected === null) current.draft = undefined;
      const updated = {
        ...current,
        draft: {
          revision: expected === null ? 1 : 3,
          basedOnPublishedRevision: 3,
          content: current.published.content,
          updatedAt: new Date(),
          updatedBy: 'user_editor',
        },
      };
      let updateFilter: Record<string, unknown> | undefined;
      const model = {
        findOne: jest.fn(() => query(current)),
        findOneAndUpdate: jest.fn((filter: Record<string, unknown>) => {
          updateFilter = filter;
          return query(updated);
        }),
      };
      const service = new ContentService(model as never);

      const result = await service.saveDraft(
        current.pageId,
        expected,
        current.published.content,
        'user_editor',
      );

      expect(updateFilter).toMatchObject({
        pageId: current.pageId,
        'published.revision': 3,
        ...(expected === null
          ? { draft: { $exists: false } }
          : { 'draft.revision': 2 }),
      });
      expect(result.draft?.revision).toBe(expected === null ? 1 : 3);
    },
  );

  it('reports a conflict when a draft save loses its update race', async () => {
    const current = pageFixture();
    const model = {
      findOne: jest.fn(() => query(current)),
      findOneAndUpdate: jest.fn(() => query(null)),
    };
    const service = new ContentService(model as never);

    await expect(
      service.saveDraft(
        current.pageId,
        2,
        current.draft?.content,
        'user_editor',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('publishes the expected draft and keeps ten historical revisions', async () => {
    const current = pageFixture();
    const updated = {
      ...current,
      published: {
        revision: 4,
        content: current.draft?.content,
        publishedAt: new Date('2026-07-22T00:00:00.000Z'),
        publishedBy: 'user_next-publisher',
      },
      draft: undefined,
      history: [current.published, ...current.history].slice(0, 10),
    };
    let publishUpdate:
      | {
          $set: {
            history: Array<{ revision: number }>;
          };
          $unset: { draft: number };
        }
      | undefined;
    let publishFilter: Record<string, unknown> | undefined;
    const findOneAndUpdate = jest.fn(
      (
        _filter: Record<string, unknown>,
        update: {
          $set: {
            history: Array<{ revision: number }>;
          };
          $unset: { draft: number };
        },
      ) => {
        publishFilter = _filter;
        publishUpdate = update;
        return query(updated);
      },
    );
    const model = {
      findOne: jest.fn(() => query(current)),
      findOneAndUpdate,
    };
    const service = new ContentService(model as never);

    const result = await service.publish(
      current.pageId,
      2,
      'user_next-publisher',
    );

    expect(publishFilter).toMatchObject({
      pageId: current.pageId,
      'published.revision': 3,
      'draft.revision': 2,
    });
    expect(publishUpdate?.$unset).toEqual({ draft: 1 });
    expect(publishUpdate?.$set.history).toHaveLength(10);
    expect(publishUpdate?.$set.history[0].revision).toBe(3);
    expect(result.published.revision).toBe(4);
    expect(result.draft).toBeNull();
  });

  it('reports a conflict when publishing loses its update race', async () => {
    const current = pageFixture();
    const model = {
      findOne: jest.fn(() => query(current)),
      findOneAndUpdate: jest.fn(() => query(null)),
    };
    const service = new ContentService(model as never);

    await expect(
      service.publish(current.pageId, 2, 'user_publisher'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a stale draft revision before writing', async () => {
    const current = pageFixture();
    const model = {
      findOne: jest.fn(() => query(current)),
      findOneAndUpdate: jest.fn(),
    };
    const service = new ContentService(model as never);

    await expect(
      service.saveDraft(
        current.pageId,
        1,
        current.draft?.content,
        'user_editor',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('discards only the expected draft revision', async () => {
    const current = pageFixture();
    const updated = { ...current, draft: undefined };
    let discardFilter: Record<string, unknown> | undefined;
    const model = {
      findOne: jest.fn(() => query(current)),
      findOneAndUpdate: jest.fn((filter: Record<string, unknown>) => {
        discardFilter = filter;
        return query(updated);
      }),
    };
    const service = new ContentService(model as never);

    const result = await service.discardDraft(current.pageId, 2);

    expect(discardFilter).toEqual({
      pageId: current.pageId,
      'draft.revision': 2,
    });
    expect(result.draft).toBeNull();
    expect(result.published.revision).toBe(3);
  });

  it('returns the page unchanged when there is no draft to discard', async () => {
    const current = pageFixture();
    current.draft = undefined;
    const model = {
      findOne: jest.fn(() => query(current)),
      findOneAndUpdate: jest.fn(),
    };
    const service = new ContentService(model as never);

    const result = await service.discardDraft(current.pageId, null);

    expect(result.draft).toBeNull();
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('reports a conflict when discarding loses its update race', async () => {
    const current = pageFixture();
    const model = {
      findOne: jest.fn(() => query(current)),
      findOneAndUpdate: jest.fn(() => query(null)),
    };
    const service = new ContentService(model as never);

    await expect(
      service.discardDraft(current.pageId, 2),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('restores an archived revision into a new draft without publishing it', async () => {
    const current = pageFixture();
    const source = current.history[1];
    let restoreFilter: Record<string, unknown> | undefined;
    let restoreUpdate: Record<string, unknown> | undefined;
    const updated = {
      ...current,
      draft: {
        revision: 3,
        basedOnPublishedRevision: 3,
        content: source.content,
        updatedAt: new Date('2026-07-23T00:00:00.000Z'),
        updatedBy: 'user_restorer',
      },
    };
    const model = {
      findOne: jest.fn(() => query(current)),
      findOneAndUpdate: jest.fn(
        (filter: Record<string, unknown>, update: Record<string, unknown>) => {
          restoreFilter = filter;
          restoreUpdate = update;
          return query(updated);
        },
      ),
    };
    const service = new ContentService(model as never);

    const result = await service.restoreRevision(
      current.pageId,
      source.revision,
      2,
      'user_restorer',
    );

    expect(restoreFilter).toMatchObject({
      pageId: current.pageId,
      'published.revision': 3,
      'draft.revision': 2,
    });
    expect(restoreUpdate).toHaveProperty('$set.draft.content', source.content);
    expect(result.published.revision).toBe(3);
    expect(result.draft?.revision).toBe(3);
    expect(result.draft?.content).toEqual(source.content);
  });

  it('restores a revision when no draft exists', async () => {
    const current = pageFixture();
    current.draft = undefined;
    const source = current.history[0];
    const updated = {
      ...current,
      draft: {
        revision: 1,
        basedOnPublishedRevision: 3,
        content: source.content,
        updatedAt: new Date(),
        updatedBy: 'user_restorer',
      },
    };
    let filter: Record<string, unknown> | undefined;
    const model = {
      findOne: jest.fn(() => query(current)),
      findOneAndUpdate: jest.fn((value: Record<string, unknown>) => {
        filter = value;
        return query(updated);
      }),
    };
    const service = new ContentService(model as never);

    await service.restoreRevision(
      current.pageId,
      source.revision,
      null,
      'user_restorer',
    );

    expect(filter).toMatchObject({ draft: { $exists: false } });
  });

  it('reports a conflict when restoring loses its update race', async () => {
    const current = pageFixture();
    const model = {
      findOne: jest.fn(() => query(current)),
      findOneAndUpdate: jest.fn(() => query(null)),
    };
    const service = new ContentService(model as never);

    await expect(
      service.restoreRevision(
        current.pageId,
        current.history[0].revision,
        2,
        'user_restorer',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
