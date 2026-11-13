import { Types } from 'mongoose';
import { CLAIM_NOT_FOUND } from './claims.service';
import {
  EXCERPT_LENGTH,
  LegacyLinksService,
  LINK_NEEDS_APPROVAL,
  LINK_PAGE_GONE,
  MAX_LEGACY_LISTED,
} from './legacy-links.service';

// Synthetic data only.
const CLAIM_ID = new Types.ObjectId();
const PROFILE_ID = new Types.ObjectId();
const OTHER_PROFILE_ID = new Types.ObjectId();
const GONE_PROFILE_ID = new Types.ObjectId();
const CLAIMANT = 'user_claimant';
const ADMIN = 'user_admin';
const PAGES_DATE = new Date('2020-05-01T00:00:00Z');

function chain(value: unknown) {
  const query = {
    select: () => query,
    sort: () => query,
    limit: () => query,
    lean: () => query,
    exec: () => Promise.resolve(value),
  };
  return query;
}
const modified = (n: number) => ({
  exec: () => Promise.resolve({ modifiedCount: n }),
});

const approvedClaim = {
  _id: CLAIM_ID,
  profileId: PROFILE_ID,
  userId: CLAIMANT,
  status: 'approved',
};

function build() {
  const claimModel = { findOne: jest.fn(() => chain(approvedClaim)) };
  const commentModel = {
    find: jest.fn(() => chain([])),
    updateOne: jest.fn(() => modified(1)),
  };
  const profileModel = {
    findOne: jest.fn(() =>
      chain({
        _id: PROFILE_ID,
        slug: 'imported-page',
        displayName: 'Synthia Example',
      }),
    ),
    find: jest.fn(() => chain([])),
  };
  const log = { record: jest.fn(() => Promise.resolve({})) };
  const service = new LegacyLinksService(
    claimModel as never,
    commentModel as never,
    profileModel as never,
    log as never,
  );
  return { service, claimModel, commentModel, profileModel, log };
}

const comment = (id: string, overrides: Record<string, unknown> = {}) => ({
  commentId: id,
  profileId: OTHER_PROFILE_ID,
  legacyAuthorName: 'Someone Else',
  body: 'Synthetic imported comment.',
  ...overrides,
});

describe('LegacyLinksService.candidates', () => {
  it('lists imported comments: linked first, then name matches, with hints only', async () => {
    const { service, commentModel, profileModel } = build();
    commentModel.find.mockReturnValueOnce(
      chain([
        comment('c_other'),
        comment('c_match', {
          legacyAuthorName: 'synthia exampl',
          legacyCreatedAt: PAGES_DATE,
          body: 'y'.repeat(EXCERPT_LENGTH + 50),
        }),
        comment('c_linked', {
          linkedUserId: CLAIMANT,
          profileId: GONE_PROFILE_ID,
        }),
      ]),
    );
    profileModel.find.mockReturnValueOnce(
      chain([
        { _id: OTHER_PROFILE_ID, slug: 'other-page', displayName: 'Other' },
        {
          _id: GONE_PROFILE_ID,
          slug: 'x',
          displayName: 'X',
          deletedAt: PAGES_DATE,
        },
      ]),
    );

    const list = await service.candidates(String(CLAIM_ID));

    expect(list.owner).toEqual({
      slug: 'imported-page',
      displayName: 'Synthia Example',
    });
    expect(list.hasMore).toBe(false);
    expect(list.comments.map((c) => c.commentId)).toEqual([
      'c_linked',
      'c_match',
      'c_other',
    ]);
    expect(list.comments[0]).toEqual({
      commentId: 'c_linked',
      name: 'Someone Else',
      excerpt: 'Synthetic imported comment.',
      linked: true,
      nameMatches: false,
    });
    expect(list.comments[1]).toEqual({
      commentId: 'c_match',
      page: { slug: 'other-page', displayName: 'Other' },
      name: 'synthia exampl',
      importedDate: PAGES_DATE.toISOString(),
      excerpt: 'y'.repeat(EXCERPT_LENGTH),
      linked: false,
      nameMatches: true,
    });
    const [filter] = commentModel.find.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(filter).toEqual({
      source: 'migrated',
      removedAt: { $exists: false },
      $or: [{ linkedUserId: { $exists: false } }, { linkedUserId: CLAIMANT }],
    });
  });

  it('says when there are more than it lists', async () => {
    const { service, commentModel } = build();
    commentModel.find.mockReturnValueOnce(
      chain(
        Array.from({ length: MAX_LEGACY_LISTED + 1 }, (_, i) =>
          comment(`c${i}`),
        ),
      ),
    );
    const list = await service.candidates(String(CLAIM_ID));
    expect(list.hasMore).toBe(true);
    expect(list.comments).toHaveLength(MAX_LEGACY_LISTED);
  });

  it('needs an approved claim whose page is still the claimant’s', async () => {
    const { service, claimModel, profileModel } = build();
    claimModel.findOne.mockReturnValueOnce(chain(null));
    await expect(service.candidates(String(CLAIM_ID))).rejects.toThrow(
      CLAIM_NOT_FOUND,
    );
    claimModel.findOne.mockReturnValueOnce(
      chain({ ...approvedClaim, status: 'pending' }),
    );
    await expect(service.candidates(String(CLAIM_ID))).rejects.toThrow(
      LINK_NEEDS_APPROVAL,
    );
    profileModel.findOne.mockReturnValueOnce(chain(null));
    await expect(service.candidates(String(CLAIM_ID))).rejects.toThrow(
      LINK_PAGE_GONE,
    );
    await expect(service.candidates('bad')).rejects.toThrow(CLAIM_NOT_FOUND);
  });
});

describe('LegacyLinksService.link / unlink', () => {
  it('links only unlinked, live, imported comments; one log entry each', async () => {
    const { service, commentModel, log } = build();
    commentModel.updateOne
      .mockReturnValueOnce(modified(1))
      .mockReturnValueOnce(modified(0));

    const result = await service.link(ADMIN, String(CLAIM_ID), [
      'c1',
      'c2',
      'c1',
    ]);

    expect(result).toEqual({ linked: ['c1'], skipped: ['c2'] });
    expect(commentModel.updateOne).toHaveBeenCalledTimes(2);
    const [filter, update] = commentModel.updateOne.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(filter).toEqual({
      commentId: 'c1',
      source: 'migrated',
      removedAt: { $exists: false },
      linkedUserId: { $exists: false },
    });
    expect(update.$set).toMatchObject({
      linkedUserId: CLAIMANT,
      linkedBy: ADMIN,
    });
    expect(log.record).toHaveBeenCalledTimes(1);
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: ADMIN,
        action: 'comment.legacy-linked',
        targetType: 'comment',
        targetId: 'c1',
        details: { claimId: String(CLAIM_ID), userId: CLAIMANT },
      }),
    );
  });

  it('unlinks only comments linked to this claimant', async () => {
    const { service, commentModel, log } = build();
    commentModel.updateOne
      .mockReturnValueOnce(modified(0))
      .mockReturnValueOnce(modified(1));
    const result = await service.unlink(ADMIN, String(CLAIM_ID), ['c1', 'c2']);
    expect(result).toEqual({ unlinked: ['c2'], skipped: ['c1'] });
    expect(commentModel.updateOne).toHaveBeenCalledWith(
      { commentId: 'c2', source: 'migrated', linkedUserId: CLAIMANT },
      { $unset: { linkedUserId: 1, linkedAt: 1, linkedBy: 1 } },
    );
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'comment.legacy-unlinked',
        reason: 'Took back the link of an imported comment.',
      }),
    );
  });
});
