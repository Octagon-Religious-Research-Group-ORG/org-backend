import { Types } from 'mongoose';
import { AdminLogService, LOG_PAGE_SIZE } from './admin-log.service';

function chain(value: unknown) {
  const query = {
    select: () => query,
    sort: () => query,
    skip: () => query,
    limit: () => query,
    lean: () => query,
    exec: () => Promise.resolve(value),
  };
  return query;
}

const AT = new Date('2026-11-13T09:00:00Z');
const row = (overrides: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  at: AT,
  actorUserId: 'user_admin',
  action: 'page.removed',
  targetType: 'member-page',
  targetId: 'p1',
  reason: 'Synthetic reason',
  ...overrides,
});

function build(rows: unknown[], pages: unknown[] = []) {
  const query = chain(rows);
  const logModel = { find: jest.fn(() => query) };
  const profileModel = { find: jest.fn(() => chain(pages)) };
  const service = new AdminLogService(logModel as never, profileModel as never);
  return { service, logModel, profileModel, query };
}

describe('AdminLogService', () => {
  it('shows the newest entries first, a page at a time, with actor names', async () => {
    const first = row({ details: { slug: 'quiet-fern' } });
    const second = row({ actorUserId: 'system:claims' });
    const { service, profileModel, query } = build(
      [first, second],
      [{ ownerUserId: 'user_admin', displayName: 'Synthetic Admin' }],
    );
    const sort = jest.spyOn(query, 'sort');
    const skip = jest.spyOn(query, 'skip');
    const result = await service.page(3);
    expect(sort).toHaveBeenCalledWith({ at: -1, _id: -1 });
    expect(skip).toHaveBeenCalledWith(2 * LOG_PAGE_SIZE);
    expect(profileModel.find).toHaveBeenCalledWith({
      ownerUserId: { $in: ['user_admin', 'system:claims'] },
      reviewStatus: { $ne: 'claiming' },
    });
    expect(result).toEqual({
      hasMore: false,
      entries: [
        {
          entryId: String(first._id),
          at: AT.toISOString(),
          actorUserId: 'user_admin',
          actorName: 'Synthetic Admin',
          action: 'page.removed',
          targetType: 'member-page',
          targetId: 'p1',
          reason: 'Synthetic reason',
          details: { slug: 'quiet-fern' },
        },
        {
          entryId: String(second._id),
          at: AT.toISOString(),
          actorUserId: 'system:claims',
          action: 'page.removed',
          targetType: 'member-page',
          targetId: 'p1',
          reason: 'Synthetic reason',
        },
      ],
    });
  });

  it('says when there are more, and reads no pages for an empty log', async () => {
    const empty = build([]);
    await expect(empty.service.page(1)).resolves.toEqual({
      entries: [],
      hasMore: false,
    });
    expect(empty.profileModel.find).not.toHaveBeenCalled();
    const full = build(Array.from({ length: LOG_PAGE_SIZE + 1 }, () => row()));
    const result = await full.service.page(1);
    expect(result.entries).toHaveLength(LOG_PAGE_SIZE);
    expect(result.hasMore).toBe(true);
  });
});
