import { fakeModel } from '../../test-support/fake-model.mocks-spec';
import { CommentAuthorsService } from './comment-authors.service';

// Chunk 17: an author whose page was deleted is "a former member" in other
// people's threads, never named; an admin's own comment stays "ORG admin".
describe('CommentAuthorsService: deleted pages', () => {
  const profiles = fakeModel([
    {
      slug: 'gone-page',
      displayName: 'Synthetic Gone',
      visibility: 'public',
      reviewStatus: 'approved',
      ownerUserId: 'user_gone',
      deletedAt: new Date('2026-11-14T00:00:00Z'),
    },
  ]);
  const authors = new CommentAuthorsService(profiles as never);
  const admin = {
    kind: 'named-member' as const,
    userId: 'user_a',
    isAdmin: true,
  };

  it('says "former" and names no one, even to an admin', async () => {
    const nameOf = await authors.resolve(['user_gone'], admin);
    expect(nameOf('user_gone')).toEqual({ kind: 'member', former: true });
    expect(nameOf('user_gone', false, true)).toEqual({
      kind: 'member',
      former: true,
    });
  });

  it('reads a purged author the same way, with no page left at all', async () => {
    const nameOf = await authors.resolve(['system:purged'], admin);
    expect(nameOf('system:purged')).toEqual({ kind: 'member', former: true });
  });

  it('keeps "ORG admin" for a comment written as an admin', async () => {
    const nameOf = await authors.resolve(['user_gone'], admin);
    expect(nameOf('user_gone', true)).toEqual({ kind: 'admin' });
  });

  it('treats the author as unknowable for receipts', async () => {
    const known = await authors.identifiable(['user_gone'], {
      kind: 'named-member',
      userId: 'user_b',
      isAdmin: false,
    });
    expect(known('user_gone')).toBe(false);
  });
});
