import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import mongoose, { Types } from 'mongoose';
import { fakeConnection } from '../../db/transactions.mocks-spec';
import {
  MAX_REMOVAL_REASON_LENGTH,
  SocialProfileSchema,
} from '../../social/schemas/social-profile.schema';
import {
  AdminMembersService,
  cleanReason,
  escapeRegex,
  MEMBERS_PAGE_SIZE,
  NOT_PENDING,
  NOT_REMOVABLE,
  NOT_REMOVED,
  OWN_PAGE,
  PAGE_CHANGED,
  PAGE_NOT_FOUND,
  REASON_NEEDED,
  REASON_TOO_LONG,
} from './admin-members.service';

const ADMIN = 'user_admin';
const OWNER = 'user_owner';
const PAGE_ID = new Types.ObjectId();
const CREATED = new Date('2026-11-01T00:00:00Z');

function chain(value: unknown) {
  const query = {
    select: () => query,
    sort: () => query,
    skip: () => query,
    limit: () => query,
    session: () => query,
    lean: () => query,
    exec: () => Promise.resolve(value),
  };
  return query;
}

const pageRow = (overrides: Record<string, unknown> = {}) => ({
  _id: PAGE_ID,
  slug: 'quiet-fern',
  displayName: 'Quiet Fern',
  reviewStatus: 'approved',
  visibility: 'public',
  anonymous: false,
  source: 'native',
  ownerUserId: OWNER,
  createdAt: CREATED,
  ...overrides,
});

function build(options: { page?: unknown; modified?: number } = {}) {
  const profileModel = {
    find: jest.fn(() => chain([])),
    findOne: jest.fn(() =>
      chain(options.page === undefined ? pageRow() : options.page),
    ),
    updateOne: jest.fn(() => ({
      exec: () => Promise.resolve({ modifiedCount: options.modified ?? 1 }),
    })),
  };
  const log = { record: jest.fn(() => Promise.resolve({})) };
  const inbox = {
    closePageNotice: jest.fn(() => Promise.resolve()),
    reopenPageNotice: jest.fn(() => Promise.resolve()),
  };
  const { connection, session } = fakeConnection();
  const service = new AdminMembersService(
    profileModel as never,
    connection as never,
    log as never,
    inbox as never,
  );
  return { service, profileModel, log, inbox, session };
}

describe('AdminMembersService.list', () => {
  it('lists every live page by name, a page at a time, with a search', async () => {
    const { service, profileModel } = build();
    const rows = Array.from({ length: MEMBERS_PAGE_SIZE + 1 }, (_, i) =>
      pageRow({ slug: `p${i}`, _id: new Types.ObjectId() }),
    );
    const query = chain(rows);
    const sort = jest.spyOn(query, 'sort');
    const skip = jest.spyOn(query, 'skip');
    profileModel.find.mockReturnValueOnce(query);
    const result = await service.list('all', ' fern. ', 2);
    expect(result.hasMore).toBe(true);
    expect(result.members).toHaveLength(MEMBERS_PAGE_SIZE);
    const [filter] = profileModel.find.mock.calls[0] as unknown as [
      Record<string, unknown> & { $or: Array<{ displayName: RegExp }> },
    ];
    expect(filter.reviewStatus).toEqual({ $ne: 'claiming' });
    expect(filter.deletedAt).toEqual({ $exists: false });
    expect(filter.$or[0].displayName.source).toBe('fern\\.');
    expect(filter.$or[0].displayName.flags).toBe('i');
    expect(sort).toHaveBeenCalledWith({ displayName: 1, _id: 1 });
    expect(skip).toHaveBeenCalledWith(MEMBERS_PAGE_SIZE);
  });

  it('filters by status; waiting pages oldest first', async () => {
    const { service, profileModel } = build();
    const query = chain([]);
    const sort = jest.spyOn(query, 'sort');
    profileModel.find.mockReturnValue(query);
    await service.list('pending', undefined, 1);
    await service.list('approved', '', 1);
    await service.list('removed', undefined, 1);
    const filters = profileModel.find.mock.calls.map(
      (call) => (call as unknown as [Record<string, unknown>])[0],
    );
    expect(filters[0]).toEqual({
      deletedAt: { $exists: false },
      reviewStatus: 'pending',
    });
    expect(filters[1].reviewStatus).toEqual({ $in: ['approved', null] });
    expect(filters[2].reviewStatus).toBe('removed');
    expect(sort).toHaveBeenNthCalledWith(1, { createdAt: 1, _id: 1 });
  });

  it('shows the admin-only facts, and nothing a list does not need', async () => {
    const { service, profileModel } = build();
    const removedAt = new Date('2026-11-12T00:00:00Z');
    profileModel.find.mockReturnValueOnce(
      chain([
        pageRow({
          reviewStatus: 'pending',
          similarNameOf: ['quiet-fem'],
          legacy: { pagesUrl: 'x' },
        }),
        pageRow({
          reviewStatus: undefined,
          anonymous: undefined,
          ownerUserId: undefined,
          createdAt: undefined,
          similarNameOf: ['ignored-when-not-pending'],
          source: 'migrated',
        }),
        pageRow({
          reviewStatus: 'removed',
          removal: {
            at: removedAt,
            by: ADMIN,
            reason: 'Synthetic reason',
            previousStatus: 'approved',
          },
        }),
        pageRow({ reviewStatus: 'pending', similarNameOf: [] }),
      ]),
    );
    const { members } = await service.list('all', undefined, 1);
    expect(members[0]).toEqual({
      slug: 'quiet-fern',
      displayName: 'Quiet Fern',
      reviewStatus: 'pending',
      visibility: 'public',
      anonymous: false,
      source: 'native',
      ownerUserId: OWNER,
      createdAt: CREATED.toISOString(),
      similarNameOf: ['quiet-fem'],
    });
    expect(members[1]).toEqual({
      slug: 'quiet-fern',
      displayName: 'Quiet Fern',
      reviewStatus: 'approved',
      visibility: 'public',
      anonymous: false,
      source: 'migrated',
    });
    expect(members[2].removal).toEqual({
      at: removedAt.toISOString(),
      by: ADMIN,
      reason: 'Synthetic reason',
      previousStatus: 'approved',
    });
    expect(members[3]).not.toHaveProperty('similarNameOf');
  });
});

describe('AdminMembersService decisions', () => {
  it('approves a waiting page, logs it and closes its notice, in one transaction', async () => {
    const { service, profileModel, log, inbox, session } = build({
      page: pageRow({ reviewStatus: 'pending' }),
    });
    await expect(service.approve(ADMIN, 'Quiet-Fern')).resolves.toEqual({
      reviewStatus: 'approved',
    });
    expect(profileModel.findOne).toHaveBeenCalledWith({
      slug: 'quiet-fern',
      deletedAt: { $exists: false },
      reviewStatus: { $ne: 'claiming' },
    });
    expect(profileModel.updateOne).toHaveBeenCalledWith(
      { _id: PAGE_ID, reviewStatus: 'pending' },
      { $set: { reviewStatus: 'approved' } },
      { session, runValidators: true },
    );
    expect(log.record).toHaveBeenCalledWith(
      {
        actorUserId: ADMIN,
        action: 'page.approved',
        targetType: 'member-page',
        targetId: String(PAGE_ID),
        reason: 'Admin approved the page.',
        details: { slug: 'quiet-fern', ownerUserId: OWNER },
      },
      session,
    );
    expect(inbox.closePageNotice).toHaveBeenCalledWith(PAGE_ID, ADMIN, session);
    expect(session.committed).toBe(1);
  });

  it('refuses to approve a page not waiting, or one that moved meanwhile', async () => {
    const { service, log } = build();
    await expect(service.approve(ADMIN, 'quiet-fern')).rejects.toThrow(
      new ConflictException(NOT_PENDING),
    );
    const moved = build({
      page: pageRow({ reviewStatus: 'pending' }),
      modified: 0,
    });
    await expect(moved.service.approve(ADMIN, 'quiet-fern')).rejects.toThrow(
      new ConflictException(PAGE_CHANGED),
    );
    expect(moved.session.aborted).toBe(1);
    expect(moved.log.record).not.toHaveBeenCalled();
    expect(log.record).not.toHaveBeenCalled();
  });

  it('never decides about your own page, an unknown page, or a bad address', async () => {
    const own = build({ page: pageRow({ ownerUserId: ADMIN }) });
    await expect(own.service.remove(ADMIN, 'quiet-fern', 'r')).rejects.toThrow(
      new ForbiddenException(OWN_PAGE),
    );
    await expect(own.service.approve(ADMIN, 'quiet-fern')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(own.service.restore(ADMIN, 'quiet-fern', 'r')).rejects.toThrow(
      ForbiddenException,
    );
    const missing = build({ page: null });
    await expect(missing.service.approve(ADMIN, 'nobody')).rejects.toThrow(
      new NotFoundException(PAGE_NOT_FOUND),
    );
    const bad = build();
    await expect(bad.service.approve(ADMIN, '../etc')).rejects.toThrow(
      NotFoundException,
    );
    expect(bad.profileModel.findOne).not.toHaveBeenCalled();
  });

  it('removes a live page softly, keeping what a restore needs', async () => {
    const { service, profileModel, log, inbox, session } = build();
    await expect(
      service.remove(ADMIN, 'quiet-fern', '  Synthetic\u0007 spam  '),
    ).resolves.toEqual({ reviewStatus: 'removed' });
    const [filter, update] = profileModel.updateOne.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      { $set: { reviewStatus: string; removal: Record<string, unknown> } },
    ];
    expect(filter).toEqual({
      _id: PAGE_ID,
      reviewStatus: { $in: ['approved', null] },
    });
    expect(update.$set.reviewStatus).toBe('removed');
    expect(update.$set.removal).toEqual({
      at: expect.any(Date) as unknown,
      by: ADMIN,
      reason: 'Synthetic spam',
      previousStatus: 'approved',
    });
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'page.removed',
        reason: 'Synthetic spam',
        details: {
          slug: 'quiet-fern',
          ownerUserId: OWNER,
          previousStatus: 'approved',
        },
      }),
      session,
    );
    expect(inbox.closePageNotice).toHaveBeenCalledWith(PAGE_ID, ADMIN, session);
  });

  it('removes an old row with no status, and an unclaimed imported page', async () => {
    const { service, log } = build({
      page: pageRow({ reviewStatus: undefined, ownerUserId: undefined }),
    });
    await service.remove(ADMIN, 'quiet-fern', 'r');
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        details: { slug: 'quiet-fern', previousStatus: 'approved' },
      }),
      expect.anything(),
    );
  });

  it('removes a waiting page from pending, and refuses an already removed one', async () => {
    const waiting = build({ page: pageRow({ reviewStatus: 'pending' }) });
    await waiting.service.remove(ADMIN, 'quiet-fern', 'r');
    expect(waiting.profileModel.updateOne).toHaveBeenCalledWith(
      { _id: PAGE_ID, reviewStatus: 'pending' },
      expect.anything(),
      expect.anything(),
    );
    const removed = build({ page: pageRow({ reviewStatus: 'removed' }) });
    await expect(
      removed.service.remove(ADMIN, 'quiet-fern', 'r'),
    ).rejects.toThrow(new ConflictException(NOT_REMOVABLE));
  });

  it('rejects only a waiting page, as a removal from pending', async () => {
    const { service, log } = build({
      page: pageRow({ reviewStatus: 'pending' }),
    });
    await expect(
      service.reject(ADMIN, 'quiet-fern', 'Not a real page'),
    ).resolves.toEqual({ reviewStatus: 'removed' });
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'page.rejected',
        details: expect.objectContaining({
          previousStatus: 'pending',
        }) as unknown,
      }),
      expect.anything(),
    );
    const live = build();
    await expect(live.service.reject(ADMIN, 'quiet-fern', 'r')).rejects.toThrow(
      new ConflictException(NOT_PENDING),
    );
  });

  it('needs a reason, within the limit, before touching anything', async () => {
    const { service, profileModel } = build();
    await expect(service.remove(ADMIN, 'quiet-fern', ' ​ ')).rejects.toThrow(
      new BadRequestException(REASON_NEEDED),
    );
    await expect(
      service.restore(
        ADMIN,
        'quiet-fern',
        'x'.repeat(MAX_REMOVAL_REASON_LENGTH + 1),
      ),
    ).rejects.toThrow(new BadRequestException(REASON_TOO_LONG));
    expect(profileModel.findOne).not.toHaveBeenCalled();
    expect(cleanReason('x'.repeat(MAX_REMOVAL_REASON_LENGTH))).toHaveLength(
      MAX_REMOVAL_REASON_LENGTH,
    );
  });

  it('restores a removed page to the status it had', async () => {
    const removedAt = new Date('2026-11-12T00:00:00Z');
    const { service, profileModel, log, session, inbox } = build({
      page: pageRow({
        reviewStatus: 'removed',
        removal: {
          at: removedAt,
          by: 'user_other',
          reason: 'Earlier',
          previousStatus: 'pending',
        },
      }),
    });
    await expect(
      service.restore(ADMIN, 'quiet-fern', 'Mistake'),
    ).resolves.toEqual({ reviewStatus: 'pending' });
    expect(profileModel.updateOne).toHaveBeenCalledWith(
      { _id: PAGE_ID, reviewStatus: 'removed' },
      { $set: { reviewStatus: 'pending' }, $unset: { removal: 1 } },
      { session, runValidators: true },
    );
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'page.restored',
        reason: 'Mistake',
        details: {
          slug: 'quiet-fern',
          ownerUserId: OWNER,
          restoredTo: 'pending',
          removedBy: 'user_other',
          removedAt: removedAt.toISOString(),
        },
      }),
      session,
    );
    // Waiting again: its inbox notice is back (review LOW-2).
    expect(inbox.reopenPageNotice).toHaveBeenCalledWith(
      PAGE_ID,
      OWNER,
      session,
    );
  });

  it('reopens no notice for a page restored to the site, or with no owner', async () => {
    const removal = {
      at: new Date(),
      by: 'user_other',
      reason: 'r',
      previousStatus: 'approved',
    };
    const live = build({ page: pageRow({ reviewStatus: 'removed', removal }) });
    await live.service.restore(ADMIN, 'quiet-fern', 'r');
    expect(live.inbox.reopenPageNotice).not.toHaveBeenCalled();
    const ownerless = build({
      page: pageRow({
        reviewStatus: 'removed',
        ownerUserId: undefined,
        removal: { ...removal, previousStatus: 'pending' },
      }),
    });
    await ownerless.service.restore(ADMIN, 'quiet-fern', 'r');
    expect(ownerless.inbox.reopenPageNotice).not.toHaveBeenCalled();
  });

  it('refuses to restore a page that is not removed', async () => {
    const live = build();
    await expect(
      live.service.restore(ADMIN, 'quiet-fern', 'r'),
    ).rejects.toThrow(new ConflictException(NOT_REMOVED));
    const noRecord = build({ page: pageRow({ reviewStatus: 'removed' }) });
    await expect(
      noRecord.service.restore(ADMIN, 'quiet-fern', 'r'),
    ).rejects.toThrow(NOT_REMOVED);
  });
});

describe('helpers and schema', () => {
  it('escapes every regular-expression character', () => {
    const text = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o';
    expect(new RegExp(escapeRegex(text)).test(text)).toBe(true);
    expect(new RegExp(`^${escapeRegex('.*')}$`).test('ab')).toBe(false);
  });

  it('keeps a removal record valid only with all its facts', () => {
    const connection = mongoose.createConnection();
    const Page = connection.model('RemovalSchemaTest', SocialProfileSchema);
    const base = {
      slug: 'quiet-fern',
      displayName: 'Quiet Fern',
      source: 'native',
      reviewStatus: 'removed',
    };
    expect(
      new Page({
        ...base,
        removal: {
          at: new Date(),
          by: ADMIN,
          reason: 'r',
          previousStatus: 'approved',
        },
      }).validateSync(),
    ).toBeUndefined();
    const error = new Page({
      ...base,
      removal: {
        at: new Date(),
        by: ADMIN,
        reason: 'r',
        previousStatus: 'removed',
      },
    }).validateSync();
    expect(error?.errors['removal.previousStatus']).toBeDefined();
    expect(SocialProfileSchema.indexes()).toContainEqual([
      { reviewStatus: 1, createdAt: 1 },
      expect.any(Object),
    ]);
    void connection.close();
  });
});
