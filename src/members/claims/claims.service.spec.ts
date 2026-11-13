import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { JOIN_CLAIM_STALE_MS } from '../../membership/membership.service';
import {
  MAX_CLAIM_MESSAGE_LENGTH,
  MAX_CLAIM_REASON_LENGTH,
  SYSTEM_CLAIMS_ACTOR,
} from '../../social/schemas/claim.schema';
import { CANNOT_CHECK_ACCOUNT } from '../comments/comment-writers';
import {
  APPROVE_LOCK_STALE_MS,
  CLAIM_BUSY,
  CLAIM_DECIDED,
  CLAIM_MESSAGE_EMPTY,
  CLAIM_MESSAGE_TOO_LONG,
  CLAIM_NOT_FOUND,
  CLAIM_REASON_TOO_LONG,
  CLAIMANT_HAS_PAGE,
  ClaimsService,
  HAS_PAGE,
  HAS_PENDING,
  isDuplicateKey,
  NOT_CLAIMABLE,
  OWN_CLAIM,
  PAGE_GONE,
  PAGE_TAKEN,
  parseClaimId,
  SITE_REASON_GONE,
  SITE_REASON_TAKEN,
  VERIFY_EMAIL_TO_CLAIM,
} from './claims.service';

// Synthetic data only.
const PROFILE_ID = new Types.ObjectId();
const OTHER_PROFILE_ID = new Types.ObjectId();
const CLAIM_ID = new Types.ObjectId();
const OTHER_CLAIM_ID = new Types.ObjectId();
const CLAIMANT = 'user_claimant';
const ADMIN = 'user_admin';
const REQUESTED = new Date('2026-11-01T10:00:00Z');

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
const exec = (value: unknown) => ({ exec: () => Promise.resolve(value) });
const modified = (n: number) => exec({ modifiedCount: n, matchedCount: n });

function claimRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: CLAIM_ID,
    profileId: PROFILE_ID,
    userId: CLAIMANT,
    message: 'Synthetic: I wrote this page in 2019.',
    status: 'pending',
    createdAt: REQUESTED,
    ...overrides,
  };
}

const visiblePage = (overrides: Record<string, unknown> = {}) => ({
  profile: {
    _id: PROFILE_ID,
    slug: 'imported-page',
    displayName: 'Synthetic Name',
    visibility: 'public',
    reviewStatus: 'approved',
    source: 'migrated',
    ...overrides,
  },
  access: { level: 'full', listed: true, isOwner: false },
});

function build() {
  const claimModel = {
    find: jest.fn(() => chain([])),
    findOne: jest.fn(() => chain(claimRow())),
    create: jest.fn((doc: Record<string, unknown>) =>
      Promise.resolve({
        toObject: () => ({ _id: CLAIM_ID, createdAt: REQUESTED, ...doc }),
      }),
    ),
    updateOne: jest.fn(() => modified(1)),
    exists: jest.fn(() => exec(null)),
    deleteOne: jest.fn(() => exec({ deletedCount: 1 })),
  };
  const profileModel = {
    find: jest.fn(() => chain([])),
    findOne: jest.fn(() => chain(null)),
    updateOne: jest.fn(() => modified(1)),
  };
  const members = {
    findVisible: jest.fn(() => Promise.resolve(visiblePage())),
  };
  const writers = { emailVerified: jest.fn(() => Promise.resolve(true)) };
  const clerk = {
    getIdentity: jest.fn(() =>
      Promise.resolve({ email: 'claimant@example.test', emailVerified: true }),
    ),
  };
  const log = { record: jest.fn(() => Promise.resolve({})) };
  const service = new ClaimsService(
    claimModel as never,
    profileModel as never,
    members as never,
    writers as never,
    clerk as never,
    log as never,
  );
  return { service, claimModel, profileModel, members, writers, clerk, log };
}

const viewer = { kind: 'signed-in' as const, userId: CLAIMANT, isAdmin: false };

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('parseClaimId / isDuplicateKey', () => {
  it('reads a 24-hex id and refuses anything else as not found', () => {
    expect(String(parseClaimId(String(CLAIM_ID)))).toBe(String(CLAIM_ID));
    expect(() => parseClaimId('nope')).toThrow(CLAIM_NOT_FOUND);
  });

  it('recognises only code 11000', () => {
    expect(isDuplicateKey({ code: 11000 })).toBe(true);
    expect(isDuplicateKey({ code: 1 })).toBe(false);
    expect(isDuplicateKey(null)).toBe(false);
    expect(isDuplicateKey('x')).toBe(false);
  });
});

describe('ClaimsService.mine', () => {
  it('lists own requests with their pages, and may claim with no page or request', async () => {
    const { service, claimModel, profileModel } = build();
    claimModel.find.mockReturnValueOnce(
      chain([
        claimRow({
          status: 'rejected',
          reason: 'Synthetic reason',
          decidedAt: REQUESTED,
        }),
        claimRow({
          _id: OTHER_CLAIM_ID,
          profileId: OTHER_PROFILE_ID,
          status: 'withdrawn',
        }),
      ]),
    );
    profileModel.find.mockReturnValueOnce(
      chain([
        { _id: PROFILE_ID, slug: 'imported-page', displayName: 'Synthetic' },
        {
          _id: OTHER_PROFILE_ID,
          slug: 'gone',
          displayName: 'Gone',
          deletedAt: REQUESTED,
        },
      ]),
    );

    const result = await service.mine(CLAIMANT);

    expect(result).toEqual({
      mayClaim: true,
      claims: [
        {
          claimId: String(CLAIM_ID),
          page: { slug: 'imported-page', displayName: 'Synthetic' },
          status: 'rejected',
          message: 'Synthetic: I wrote this page in 2019.',
          requestedAt: REQUESTED.toISOString(),
          decidedAt: REQUESTED.toISOString(),
          reason: 'Synthetic reason',
        },
        {
          claimId: String(OTHER_CLAIM_ID),
          status: 'withdrawn',
          message: 'Synthetic: I wrote this page in 2019.',
          requestedAt: REQUESTED.toISOString(),
        },
      ],
    });
  });

  it('says has-page for an account with a page, even with nothing asked', async () => {
    const { service, profileModel, writers } = build();
    profileModel.findOne.mockReturnValueOnce(
      chain({ reviewStatus: 'approved', createdAt: REQUESTED }),
    );
    expect(await service.mine(CLAIMANT)).toEqual({
      mayClaim: false,
      block: 'has-page',
      claims: [],
    });
    expect(profileModel.find).not.toHaveBeenCalled();
    expect(writers.emailVerified).not.toHaveBeenCalled();
  });

  it('counts a join still in progress as a page, but not one that died', async () => {
    const { service, profileModel } = build();
    profileModel.findOne.mockReturnValueOnce(
      chain({ reviewStatus: 'claiming', createdAt: new Date() }),
    );
    expect((await service.mine(CLAIMANT)).block).toBe('has-page');
    profileModel.findOne.mockReturnValueOnce(
      chain({
        reviewStatus: 'claiming',
        createdAt: new Date(Date.now() - JOIN_CLAIM_STALE_MS - 1000),
      }),
    );
    expect((await service.mine(CLAIMANT)).mayClaim).toBe(true);
  });

  it('says has-pending while a request waits', async () => {
    const { service, claimModel, profileModel } = build();
    claimModel.find.mockReturnValueOnce(chain([claimRow()]));
    profileModel.find.mockReturnValueOnce(chain([]));
    expect((await service.mine(CLAIMANT)).block).toBe('has-pending');
  });

  it('says verify-email, or cannot-check when Clerk fails', async () => {
    const { service, writers } = build();
    writers.emailVerified.mockResolvedValueOnce(false);
    expect((await service.mine(CLAIMANT)).block).toBe('verify-email');
    writers.emailVerified.mockRejectedValueOnce(new Error('down'));
    expect((await service.mine(CLAIMANT)).block).toBe('cannot-check');
  });
});

describe('ClaimsService.request', () => {
  it('records a request and its log entry, with the cleaned message', async () => {
    const { service, claimModel, log } = build();

    const view = await service.request(
      viewer,
      'Imported-Page',
      '  Synthetic: I wrote it\u0007.  ',
    );

    expect(claimModel.create).toHaveBeenCalledWith({
      profileId: PROFILE_ID,
      userId: CLAIMANT,
      message: 'Synthetic: I wrote it.',
      status: 'pending',
    });
    expect(view).toEqual({
      claimId: String(CLAIM_ID),
      page: { slug: 'imported-page', displayName: 'Synthetic Name' },
      status: 'pending',
      message: 'Synthetic: I wrote it.',
      requestedAt: REQUESTED.toISOString(),
    });
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: CLAIMANT,
        action: 'claim.requested',
        targetType: 'claim',
        targetId: String(CLAIM_ID),
      }),
    );
  });

  it('refuses an empty or too long message before reading anything', async () => {
    const { service, members } = build();
    await expect(
      service.request(viewer, 'imported-page', ' ​ '),
    ).rejects.toThrow(CLAIM_MESSAGE_EMPTY);
    await expect(
      service.request(
        viewer,
        'imported-page',
        'x'.repeat(MAX_CLAIM_MESSAGE_LENGTH + 1),
      ),
    ).rejects.toThrow(CLAIM_MESSAGE_TOO_LONG);
    expect(members.findVisible).not.toHaveBeenCalled();
  });

  it('passes on the 404 of a page the reader may not see', async () => {
    const { service, members, claimModel } = build();
    members.findVisible.mockRejectedValueOnce(new NotFoundException('x'));
    await expect(service.request(viewer, 'nope', 'hi')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(claimModel.create).not.toHaveBeenCalled();
  });

  it.each([
    ['owned', { ownerUserId: 'someone' }],
    ['native', { source: 'native' }],
    ['pending', { reviewStatus: 'pending' }],
    ['deleted', { deletedAt: REQUESTED }],
  ])('refuses a page that is not claimable (%s)', async (_label, overrides) => {
    const { service, members } = build();
    members.findVisible.mockResolvedValueOnce(visiblePage(overrides));
    await expect(service.request(viewer, 'p', 'hi')).rejects.toThrow(
      NOT_CLAIMABLE,
    );
  });

  it('treats a page with no review status as approved', async () => {
    const { service, members } = build();
    members.findVisible.mockResolvedValueOnce(
      visiblePage({ reviewStatus: undefined }),
    );
    await expect(service.request(viewer, 'p', 'hi')).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('refuses an account that has a page, or a request waiting', async () => {
    const { service, profileModel, claimModel } = build();
    profileModel.findOne.mockReturnValueOnce(
      chain({ reviewStatus: 'approved', createdAt: REQUESTED }),
    );
    await expect(service.request(viewer, 'p', 'hi')).rejects.toThrow(
      new ForbiddenException(HAS_PAGE),
    );
    claimModel.exists.mockReturnValueOnce(exec({ _id: OTHER_CLAIM_ID }));
    await expect(service.request(viewer, 'p', 'hi')).rejects.toThrow(
      new ConflictException(HAS_PENDING),
    );
  });

  it('refuses an unconfirmed email; a Clerk failure is 503, a rejected account stays 401', async () => {
    const { service, writers } = build();
    writers.emailVerified.mockResolvedValueOnce(false);
    await expect(service.request(viewer, 'p', 'hi')).rejects.toThrow(
      new ForbiddenException(VERIFY_EMAIL_TO_CLAIM),
    );
    writers.emailVerified.mockRejectedValueOnce(new Error('down'));
    await expect(service.request(viewer, 'p', 'hi')).rejects.toThrow(
      new ServiceUnavailableException(CANNOT_CHECK_ACCOUNT),
    );
    writers.emailVerified.mockRejectedValueOnce(new UnauthorizedException());
    await expect(service.request(viewer, 'p', 'hi')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    writers.emailVerified.mockRejectedValueOnce(new ForbiddenException('odd'));
    await expect(service.request(viewer, 'p', 'hi')).rejects.toThrow(
      new ServiceUnavailableException(CANNOT_CHECK_ACCOUNT),
    );
  });

  it('turns the unique index of a second waiting request into a 409', async () => {
    const { service, claimModel } = build();
    claimModel.create.mockRejectedValueOnce({ code: 11000 });
    await expect(service.request(viewer, 'p', 'hi')).rejects.toThrow(
      new ConflictException(HAS_PENDING),
    );
    const other = new Error('other');
    claimModel.create.mockRejectedValueOnce(other);
    await expect(service.request(viewer, 'p', 'hi')).rejects.toBe(other);
  });

  it('removes the request when its log entry cannot be written', async () => {
    const { service, claimModel, log } = build();
    const failure = new Error('log down');
    log.record.mockRejectedValueOnce(failure);
    await expect(service.request(viewer, 'p', 'hi')).rejects.toBe(failure);
    expect(claimModel.deleteOne).toHaveBeenCalledWith({
      _id: CLAIM_ID,
      status: 'pending',
    });
    // Even when that removal fails, the first error is the one reported.
    log.record.mockRejectedValueOnce(failure);
    claimModel.deleteOne.mockReturnValueOnce({
      exec: () => Promise.reject(new Error('db down')),
    });
    await expect(service.request(viewer, 'p', 'hi')).rejects.toBe(failure);
  });
});

describe('ClaimsService.withdraw', () => {
  it('withdraws the member’s own waiting request and records it', async () => {
    const { service, claimModel, log } = build();
    expect(await service.withdraw(CLAIMANT, String(CLAIM_ID))).toEqual({
      withdrawn: true,
    });
    const [filter, update] = claimModel.updateOne.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(filter).toMatchObject({
      _id: CLAIM_ID,
      userId: CLAIMANT,
      status: 'pending',
    });
    expect(update.$set).toMatchObject({
      status: 'withdrawn',
      decidedBy: CLAIMANT,
    });
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'claim.withdrawn' }),
    );
  });

  it('answers someone else’s or a missing request with the same 404', async () => {
    const { service, claimModel } = build();
    await expect(
      service.withdraw('user_other', String(CLAIM_ID)),
    ).rejects.toThrow(CLAIM_NOT_FOUND);
    claimModel.findOne.mockReturnValueOnce(chain(null));
    await expect(service.withdraw(CLAIMANT, String(CLAIM_ID))).rejects.toThrow(
      CLAIM_NOT_FOUND,
    );
  });

  it('refuses while being approved, and after a decision', async () => {
    const { service, claimModel } = build();
    claimModel.updateOne.mockReturnValueOnce(modified(0));
    claimModel.findOne
      .mockReturnValueOnce(chain(claimRow({ approvingAt: new Date() })))
      .mockReturnValueOnce(chain(claimRow({ approvingAt: new Date() })));
    await expect(service.withdraw(CLAIMANT, String(CLAIM_ID))).rejects.toThrow(
      CLAIM_BUSY,
    );
    claimModel.updateOne.mockReturnValueOnce(modified(0));
    claimModel.findOne
      .mockReturnValueOnce(chain(claimRow()))
      .mockReturnValueOnce(chain(claimRow({ status: 'approved' })));
    await expect(service.withdraw(CLAIMANT, String(CLAIM_ID))).rejects.toThrow(
      CLAIM_DECIDED,
    );
    claimModel.updateOne.mockReturnValueOnce(modified(0));
    claimModel.findOne
      .mockReturnValueOnce(chain(claimRow()))
      .mockReturnValueOnce(chain(null));
    await expect(service.withdraw(CLAIMANT, String(CLAIM_ID))).rejects.toThrow(
      CLAIM_DECIDED,
    );
  });

  it('finishes an approval that died after binding instead of withdrawing', async () => {
    const { service, claimModel, profileModel, log } = build();
    const stale = new Date(Date.now() - APPROVE_LOCK_STALE_MS - 1000);
    claimModel.findOne
      .mockReturnValueOnce(chain(claimRow({ approvingAt: stale })))
      .mockReturnValueOnce(chain(claimRow({ status: 'approved' })));
    profileModel.findOne.mockReturnValueOnce(chain({ ownerUserId: CLAIMANT }));
    claimModel.updateOne
      .mockReturnValueOnce(modified(1)) // finish: approved
      .mockReturnValueOnce(modified(0)); // the withdrawal finds it decided
    await expect(service.withdraw(CLAIMANT, String(CLAIM_ID))).rejects.toThrow(
      CLAIM_DECIDED,
    );
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'claim.approved',
        actorUserId: SYSTEM_CLAIMS_ACTOR,
      }),
    );
  });
});

describe('ClaimsService.adminList', () => {
  it('shows the queue with the claimant’s account and the page', async () => {
    const { service, claimModel, profileModel, clerk } = build();
    claimModel.find.mockReturnValueOnce(
      chain([
        claimRow({ approvingAt: new Date() }),
        claimRow({
          _id: OTHER_CLAIM_ID,
          userId: 'user_b',
          profileId: OTHER_PROFILE_ID,
          approvingAt: new Date(Date.now() - APPROVE_LOCK_STALE_MS - 1000),
        }),
        claimRow({ _id: new Types.ObjectId(), userId: 'user_c' }),
      ]),
    );
    profileModel.find.mockReturnValueOnce(
      chain([{ _id: PROFILE_ID, slug: 'imported-page', displayName: 'S' }]),
    );
    clerk.getIdentity
      .mockResolvedValueOnce({ email: 'a@example.test', emailVerified: true })
      .mockResolvedValueOnce({ emailVerified: false } as never)
      .mockRejectedValueOnce(new Error('down'));

    const { claims } = await service.adminList('pending');

    expect(claims[0]).toEqual({
      claimId: String(CLAIM_ID),
      status: 'pending',
      approving: true,
      message: 'Synthetic: I wrote this page in 2019.',
      requestedAt: REQUESTED.toISOString(),
      decidedBySite: false,
      claimant: {
        userId: CLAIMANT,
        email: 'a@example.test',
        emailVerified: true,
      },
      page: { slug: 'imported-page', displayName: 'S' },
    });
    expect(claims[1]).toMatchObject({
      approving: false,
      claimant: { userId: 'user_b', emailVerified: false },
    });
    expect(claims[1]).not.toHaveProperty('page');
    expect(claims[2].claimant).toEqual({ userId: 'user_c' });
  });

  it('shows decided claims with who decided and why', async () => {
    const { service, claimModel } = build();
    claimModel.find.mockReturnValueOnce(
      chain([
        claimRow({
          status: 'rejected',
          decidedBy: SYSTEM_CLAIMS_ACTOR,
          decidedAt: REQUESTED,
          reason: SITE_REASON_TAKEN,
          approvingAt: new Date(),
        }),
      ]),
    );
    const { claims } = await service.adminList('rejected');
    expect(claims[0]).toMatchObject({
      approving: false,
      decidedBySite: true,
      decidedAt: REQUESTED.toISOString(),
      reason: SITE_REASON_TAKEN,
    });
  });
});

describe('ClaimsService.approve', () => {
  it('locks, binds only an ownerless imported page, approves, records, rejects the others', async () => {
    const { service, claimModel, profileModel, log } = build();
    const other = claimRow({ _id: OTHER_CLAIM_ID, userId: 'user_b' });
    claimModel.find.mockReturnValueOnce(chain([other]));

    expect(await service.approve(ADMIN, String(CLAIM_ID))).toEqual({
      approved: true,
    });

    const [lockFilter, lockUpdate] = claimModel.updateOne.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      { $set: { approvingAt: Date } },
    ];
    expect(lockFilter).toMatchObject({ _id: CLAIM_ID, status: 'pending' });
    expect(lockUpdate.$set.approvingAt).toBeInstanceOf(Date);
    expect(profileModel.updateOne).toHaveBeenCalledWith(
      {
        _id: PROFILE_ID,
        source: 'migrated',
        ownerUserId: { $exists: false },
        deletedAt: { $exists: false },
      },
      { $set: { ownerUserId: CLAIMANT } },
    );
    const [, approved] = claimModel.updateOne.mock.calls[1] as unknown as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(approved.$set).toMatchObject({
      status: 'approved',
      decidedBy: ADMIN,
    });
    const [othersFilter, othersUpdate] = claimModel.updateOne.mock
      .calls[2] as unknown as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(othersFilter).toEqual({ _id: OTHER_CLAIM_ID, status: 'pending' });
    expect(othersUpdate.$set).toMatchObject({
      status: 'rejected',
      decidedBy: SYSTEM_CLAIMS_ACTOR,
      reason: SITE_REASON_TAKEN,
    });
    expect(
      log.record.mock.calls.map(
        (call) => (call as unknown as [{ action: string }])[0].action,
      ),
    ).toEqual(['claim.approved', 'claim.rejected']);
  });

  it('records nothing for a claim another decision already finished', async () => {
    const { service, claimModel, log } = build();
    claimModel.updateOne
      .mockReturnValueOnce(modified(1)) // lock
      .mockReturnValueOnce(modified(0)); // already approved elsewhere
    await service.approve(ADMIN, String(CLAIM_ID));
    expect(log.record).not.toHaveBeenCalled();
  });

  it('skips logging another claim that was decided meanwhile', async () => {
    const { service, claimModel, log } = build();
    claimModel.find.mockReturnValueOnce(
      chain([claimRow({ _id: OTHER_CLAIM_ID, userId: 'user_b' })]),
    );
    claimModel.updateOne
      .mockReturnValueOnce(modified(1))
      .mockReturnValueOnce(modified(1))
      .mockReturnValueOnce(modified(0));
    await service.approve(ADMIN, String(CLAIM_ID));
    expect(log.record).toHaveBeenCalledTimes(1);
  });

  it('refuses no such request, the admin’s own, and a decided one', async () => {
    const { service, claimModel } = build();
    claimModel.findOne.mockReturnValueOnce(chain(null));
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      CLAIM_NOT_FOUND,
    );
    await expect(service.approve(CLAIMANT, String(CLAIM_ID))).rejects.toThrow(
      new ForbiddenException(OWN_CLAIM),
    );
    claimModel.findOne.mockReturnValueOnce(
      chain(claimRow({ status: 'rejected' })),
    );
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      CLAIM_DECIDED,
    );
    await expect(service.approve(ADMIN, 'bad')).rejects.toThrow(
      CLAIM_NOT_FOUND,
    );
  });

  it('is busy while another approval holds the lock', async () => {
    const { service, claimModel, profileModel } = build();
    claimModel.updateOne.mockReturnValueOnce(modified(0));
    claimModel.findOne
      .mockReturnValueOnce(chain(claimRow({ approvingAt: new Date() })))
      .mockReturnValueOnce(chain(claimRow({ approvingAt: new Date() })));
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      CLAIM_BUSY,
    );
    expect(profileModel.updateOne).not.toHaveBeenCalled();
  });

  it('finishes an approval that died after binding, and says it is decided', async () => {
    const { service, claimModel, profileModel } = build();
    claimModel.findOne.mockReturnValueOnce(
      chain(
        claimRow({
          approvingAt: new Date(Date.now() - APPROVE_LOCK_STALE_MS - 1000),
        }),
      ),
    );
    profileModel.findOne.mockReturnValueOnce(chain({ ownerUserId: CLAIMANT }));
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      CLAIM_DECIDED,
    );
    expect(profileModel.updateOne).not.toHaveBeenCalled();
  });

  it('takes over a dead approval that never bound the page', async () => {
    const { service, claimModel, profileModel } = build();
    claimModel.findOne.mockReturnValueOnce(
      chain(
        claimRow({
          approvingAt: new Date(Date.now() - APPROVE_LOCK_STALE_MS - 1000),
        }),
      ),
    );
    profileModel.findOne.mockReturnValueOnce(chain({}));
    await expect(service.approve(ADMIN, String(CLAIM_ID))).resolves.toEqual({
      approved: true,
    });
    // Also when the page row itself is gone: the bind then decides.
    claimModel.findOne.mockReturnValueOnce(
      chain(
        claimRow({
          approvingAt: new Date(Date.now() - APPROVE_LOCK_STALE_MS - 1000),
        }),
      ),
    );
    profileModel.findOne.mockReturnValueOnce(chain(null));
    await expect(service.approve(ADMIN, String(CLAIM_ID))).resolves.toEqual({
      approved: true,
    });
  });

  it('releases the lock and refuses when the claimant owns a page already', async () => {
    const { service, claimModel, profileModel } = build();
    profileModel.updateOne.mockReturnValueOnce({
      exec: () =>
        Promise.reject(Object.assign(new Error('E11000'), { code: 11000 })),
    });
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      new ConflictException(CLAIMANT_HAS_PAGE),
    );
    const [releaseFilter, release] = claimModel.updateOne.mock
      .calls[1] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(releaseFilter).toMatchObject({ _id: CLAIM_ID, status: 'pending' });
    expect(releaseFilter.approvingAt).toBeInstanceOf(Date);
    expect(release).toEqual({ $unset: { approvingAt: 1 } });

    const failure = new Error('db down');
    profileModel.updateOne.mockReturnValueOnce({
      exec: () => Promise.reject(failure),
    });
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toBe(
      failure,
    );
  });

  it('rejects the claim when the page went to someone else, or is gone', async () => {
    const { service, profileModel, claimModel, log } = build();
    profileModel.updateOne.mockReturnValue(modified(0));
    profileModel.findOne.mockReturnValueOnce(chain({ ownerUserId: 'user_b' }));
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      PAGE_TAKEN,
    );
    const [filter, update] = claimModel.updateOne.mock.calls[1] as unknown as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(filter.approvingAt).toBeInstanceOf(Date);
    expect(update.$set).toMatchObject({
      status: 'rejected',
      reason: SITE_REASON_TAKEN,
    });
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'claim.rejected',
        reason: SITE_REASON_TAKEN,
      }),
    );

    profileModel.findOne.mockReturnValueOnce(chain(null));
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      PAGE_GONE,
    );
    profileModel.findOne.mockReturnValueOnce(
      chain({ ownerUserId: 'user_b', deletedAt: REQUESTED }),
    );
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      PAGE_GONE,
    );
    expect(log.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: SITE_REASON_GONE }),
    );
  });

  it('finishes when the page is already the claimant’s', async () => {
    const { service, profileModel } = build();
    profileModel.updateOne.mockReturnValueOnce(modified(0));
    profileModel.findOne.mockReturnValueOnce(chain({ ownerUserId: CLAIMANT }));
    await expect(service.approve(ADMIN, String(CLAIM_ID))).resolves.toEqual({
      approved: true,
    });
  });
});

describe('ClaimsService.reject', () => {
  it('rejects with a cleaned reason, shown to the claimant, and records it', async () => {
    const { service, claimModel, log } = build();
    expect(
      await service.reject(ADMIN, String(CLAIM_ID), '  Synthetic\nreason  '),
    ).toEqual({ rejected: true });
    const [, update] = claimModel.updateOne.mock.calls[0] as unknown as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(update.$set).toMatchObject({
      status: 'rejected',
      decidedBy: ADMIN,
      reason: 'Synthetic reason',
    });
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'claim.rejected',
        reason: 'Synthetic reason',
      }),
    );
  });

  it('rejects without a reason', async () => {
    const { service, claimModel, log } = build();
    await service.reject(ADMIN, String(CLAIM_ID));
    const [, update] = claimModel.updateOne.mock.calls[0] as unknown as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(update.$set).not.toHaveProperty('reason');
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Rejected without a reason.' }),
    );
  });

  it('refuses a reason over its limit, its own request, and a busy or decided one', async () => {
    const { service, claimModel } = build();
    await expect(
      service.reject(
        ADMIN,
        String(CLAIM_ID),
        'x'.repeat(MAX_CLAIM_REASON_LENGTH + 1),
      ),
    ).rejects.toThrow(new BadRequestException(CLAIM_REASON_TOO_LONG));
    await expect(service.reject(CLAIMANT, String(CLAIM_ID))).rejects.toThrow(
      OWN_CLAIM,
    );
    claimModel.updateOne.mockReturnValueOnce(modified(0));
    claimModel.findOne
      .mockReturnValueOnce(chain(claimRow({ approvingAt: new Date() })))
      .mockReturnValueOnce(chain(claimRow({ approvingAt: new Date() })));
    await expect(service.reject(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      CLAIM_BUSY,
    );
  });

  it('does not reject a claim whose dead approval bound the page', async () => {
    const { service, claimModel, profileModel } = build();
    claimModel.findOne.mockReturnValueOnce(
      chain(
        claimRow({
          approvingAt: new Date(Date.now() - APPROVE_LOCK_STALE_MS - 1000),
        }),
      ),
    );
    profileModel.findOne.mockReturnValueOnce(chain({ ownerUserId: CLAIMANT }));
    await expect(service.reject(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      CLAIM_DECIDED,
    );
  });
});
