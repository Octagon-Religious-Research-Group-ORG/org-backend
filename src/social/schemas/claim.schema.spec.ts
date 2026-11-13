import { ClaimSchema } from './claim.schema';

describe('claims schema (Chunk 11)', () => {
  it('declares the indexes that keep one waiting request per login and one approval per page', () => {
    expect(ClaimSchema.indexes()).toEqual([
      [
        { userId: 1 },
        { unique: true, partialFilterExpression: { status: 'pending' } },
      ],
      [
        { profileId: 1 },
        { unique: true, partialFilterExpression: { status: 'approved' } },
      ],
      [{ status: 1, createdAt: 1 }, {}],
      [{ userId: 1, createdAt: -1 }, {}],
      [{ profileId: 1, status: 1 }, {}],
    ]);
  });

  it('is created and indexed only deliberately', () => {
    expect(ClaimSchema.get('autoIndex')).toBe(false);
    expect(ClaimSchema.get('autoCreate')).toBe(false);
  });
});
