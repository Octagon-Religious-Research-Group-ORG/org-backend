import { Types } from 'mongoose';
import { pageView } from './claim-views';

const page = {
  _id: new Types.ObjectId(),
  slug: 'imported-page',
  displayName: 'Synthetic Page',
};

describe('pageView', () => {
  it('names a live page', () => {
    expect(pageView(page)).toEqual({
      page: { slug: 'imported-page', displayName: 'Synthetic Page' },
    });
    expect(pageView({ ...page, reviewStatus: 'approved' })).toHaveProperty(
      'page',
    );
  });

  it('names no page that is gone: missing, deleted, or removed by an admin (Chunk 12)', () => {
    expect(pageView(undefined)).toEqual({});
    expect(pageView({ ...page, deletedAt: new Date() })).toEqual({});
    expect(pageView({ ...page, reviewStatus: 'removed' })).toEqual({});
  });
});
