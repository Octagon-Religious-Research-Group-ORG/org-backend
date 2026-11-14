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
  CLAIM_DECIDED,
  CLAIMS_NEED_REPLICA_SET,
  CLAIM_MESSAGE_EMPTY,
  CLAIM_MESSAGE_TOO_LONG,
  CLAIM_NOT_FOUND,
  CLAIM_REASON_TOO_LONG,
  CLAIMANT_GONE,
  CLAIMANT_HAS_PAGE,
  CLAIMANT_UNVERIFIED,
  ClaimsService,
  HAS_PAGE,
  HAS_PENDING,
  isDuplicateKey,
  isTransactionUnsupported,
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
    session: () => query,
    exec: () => Promise.resolve(value),
  };
  return query;
}

/**
 * A session whose transaction runs its work once and counts what an abort
 * would undo; the real atomicity is tested on a replica set (e2e).
 */
function fakeSession() {
  const session = {
    aborted: 0,
    withTransaction: jest.fn(async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        session.aborted += 1;
        throw error;
      }
    }),
    endSession: jest.fn(() => Promise.resolve()),
  };
  return session;
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

function build(notifier?: unknown) {
  const session = fakeSession();
  const claimModel = {
    db: { startSession: jest.fn(() => Promise.resolve(session)) },
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
  const log = {
    record: jest.fn<Promise<unknown>, [unknown, unknown?]>(() =>
      Promise.resolve({}),
    ),
  };
  const service = new ClaimsService(
    claimModel as never,
    profileModel as never,
    members as never,
    writers as never,
    clerk as never,
    log as never,
    notifier as never,
  );
  return {
    service,
    claimModel,
    profileModel,
    members,
    writers,
    clerk,
    log,
    session,
  };
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
  it('withdraws the member’s own waiting request and records it, in one transaction', async () => {
    const { service, claimModel, log, session } = build();
    expect(await service.withdraw(CLAIMANT, String(CLAIM_ID))).toEqual({
      withdrawn: true,
    });
    const [filter, update, options] = claimModel.updateOne.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
      { session: unknown },
    ];
    expect(filter).toEqual({ _id: CLAIM_ID, status: 'pending' });
    expect(update.$set).toMatchObject({
      status: 'withdrawn',
      decidedBy: CLAIMANT,
    });
    expect(options.session).toBe(session);
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'claim.withdrawn' }),
      session,
    );
    expect(session.endSession).toHaveBeenCalled();
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

  it('refuses a request decided meanwhile, and records nothing', async () => {
    const { service, claimModel, log, session } = build();
    claimModel.updateOne.mockReturnValueOnce(modified(0));
    await expect(service.withdraw(CLAIMANT, String(CLAIM_ID))).rejects.toThrow(
      new ConflictException(CLAIM_DECIDED),
    );
    expect(log.record).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalled();
  });
});

describe('ClaimsService.adminList', () => {
  it('shows the queue with the claimant’s account and the page', async () => {
    const { service, claimModel, profileModel, clerk } = build();
    claimModel.find.mockReturnValueOnce(
      chain([
        claimRow(),
        claimRow({
          _id: OTHER_CLAIM_ID,
          userId: 'user_b',
          profileId: OTHER_PROFILE_ID,
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
        }),
      ]),
    );
    const { claims } = await service.adminList('rejected');
    expect(claims[0]).toMatchObject({
      decidedBySite: true,
      decidedAt: REQUESTED.toISOString(),
      reason: SITE_REASON_TAKEN,
    });
  });
});

describe('ClaimsService.approve', () => {
  it('approves, binds only an approved ownerless imported page and logs it in ONE transaction, then rejects the others', async () => {
    const { service, claimModel, profileModel, log, session } = build();
    const other = claimRow({ _id: OTHER_CLAIM_ID, userId: 'user_b' });
    claimModel.find.mockReturnValueOnce(chain([other]));

    expect(await service.approve(ADMIN, String(CLAIM_ID))).toEqual({
      approved: true,
    });

    const [casFilter, cas, casOptions] = claimModel.updateOne.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
      { session: unknown },
    ];
    expect(casFilter).toEqual({ _id: CLAIM_ID, status: 'pending' });
    expect(cas.$set).toMatchObject({ status: 'approved', decidedBy: ADMIN });
    expect(casOptions.session).toBe(session);
    expect(profileModel.updateOne).toHaveBeenCalledWith(
      {
        _id: PROFILE_ID,
        source: 'migrated',
        reviewStatus: 'approved',
        ownerUserId: { $exists: false },
        deletedAt: { $exists: false },
      },
      { $set: { ownerUserId: CLAIMANT } },
      { session },
    );
    const [othersFilter, othersUpdate] = claimModel.updateOne.mock
      .calls[1] as unknown as [
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
    // Every write went inside a transaction: one for the approval, one per
    // other request.
    expect(session.withTransaction).toHaveBeenCalledTimes(2);
  });

  it('skips logging another claim that was decided meanwhile', async () => {
    const { service, claimModel, log } = build();
    claimModel.find.mockReturnValueOnce(
      chain([claimRow({ _id: OTHER_CLAIM_ID, userId: 'user_b' })]),
    );
    claimModel.updateOne
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

  it('answers decided, binding nothing, when another decision got there first', async () => {
    const { service, claimModel, profileModel, log } = build();
    claimModel.updateOne.mockReturnValueOnce(modified(0));
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      new ConflictException(CLAIM_DECIDED),
    );
    expect(profileModel.updateOne).not.toHaveBeenCalled();
    expect(log.record).not.toHaveBeenCalled();
  });

  it('checks the claimant again: gone, unconfirmed, or not checkable', async () => {
    const { service, writers, claimModel } = build();
    writers.emailVerified.mockRejectedValueOnce(new UnauthorizedException());
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      new ConflictException(CLAIMANT_GONE),
    );
    writers.emailVerified.mockResolvedValueOnce(false);
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      new ConflictException(CLAIMANT_UNVERIFIED),
    );
    writers.emailVerified.mockRejectedValueOnce(new Error('down'));
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      new ServiceUnavailableException(CANNOT_CHECK_ACCOUNT),
    );
    writers.emailVerified.mockRejectedValueOnce(new ForbiddenException('odd'));
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      new ServiceUnavailableException(CANNOT_CHECK_ACCOUNT),
    );
    expect(claimModel.updateOne).not.toHaveBeenCalled();
  });

  it('refuses when the claimant owns a page already; the transaction undoes the approval', async () => {
    const { service, profileModel, log, session } = build();
    profileModel.updateOne.mockReturnValueOnce({
      exec: () =>
        Promise.reject(Object.assign(new Error('E11000'), { code: 11000 })),
    });
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      new ConflictException(CLAIMANT_HAS_PAGE),
    );
    expect(session.aborted).toBe(1);
    expect(log.record).not.toHaveBeenCalled();

    const failure = new Error('db down');
    profileModel.updateOne.mockReturnValueOnce({
      exec: () => Promise.reject(failure),
    });
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toBe(
      failure,
    );
  });

  it('rejects the claim, in its own transaction, when the page went to someone else or is gone', async () => {
    const { service, profileModel, claimModel, log, session } = build();
    profileModel.updateOne.mockReturnValue(modified(0));
    profileModel.findOne.mockReturnValueOnce(chain({}));
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      PAGE_TAKEN,
    );
    expect(session.aborted).toBe(1);
    const [filter, update] = claimModel.updateOne.mock.calls[1] as unknown as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(filter).toEqual({ _id: CLAIM_ID, status: 'pending' });
    expect(update.$set).toMatchObject({
      status: 'rejected',
      reason: SITE_REASON_TAKEN,
    });
    expect(log.record).toHaveBeenCalledTimes(1);
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'claim.rejected',
        reason: SITE_REASON_TAKEN,
      }),
      session,
    );

    profileModel.findOne.mockReturnValueOnce(chain(null));
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      PAGE_GONE,
    );
    profileModel.findOne.mockReturnValueOnce(chain({ deletedAt: REQUESTED }));
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      PAGE_GONE,
    );
    // An admin removed it (Chunk 12): gone for the claimant too.
    profileModel.findOne.mockReturnValueOnce(
      chain({ reviewStatus: 'removed' }),
    );
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      PAGE_GONE,
    );
    expect(log.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: SITE_REASON_GONE }),
      session,
    );
  });

  it('treats a page that already has an approved claim as taken', async () => {
    const { service, claimModel, profileModel } = build();
    claimModel.updateOne.mockReturnValueOnce({
      exec: () =>
        Promise.reject(Object.assign(new Error('E11000'), { code: 11000 })),
    });
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      PAGE_TAKEN,
    );
    expect(profileModel.updateOne).not.toHaveBeenCalled();
    const failure = new Error('db down');
    claimModel.updateOne.mockReturnValueOnce({
      exec: () => Promise.reject(failure),
    });
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toBe(
      failure,
    );
  });
});

describe('ClaimsService.reject', () => {
  it('rejects with a cleaned reason, shown to the claimant, and records it in one transaction', async () => {
    const { service, claimModel, log, session } = build();
    expect(
      await service.reject(ADMIN, String(CLAIM_ID), '  Synthetic\nreason  '),
    ).toEqual({ rejected: true });
    const [filter, update] = claimModel.updateOne.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(filter).toEqual({ _id: CLAIM_ID, status: 'pending' });
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
      session,
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
      expect.anything(),
    );
  });

  it('refuses a reason over its limit, its own request, and a decided one', async () => {
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
    await expect(service.reject(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      CLAIM_DECIDED,
    );
  });
});

describe('review round 2', () => {
  it('a committed approval stays approved when rejecting the others fails', async () => {
    const { service, claimModel, session } = build();
    const failing = chain([]);
    failing.exec = () => Promise.reject(new Error('list down'));
    claimModel.find.mockReturnValueOnce(failing);
    await expect(service.approve(ADMIN, String(CLAIM_ID))).resolves.toEqual({
      approved: true,
    });

    claimModel.find.mockReturnValueOnce(
      chain([
        claimRow({ _id: OTHER_CLAIM_ID, userId: 'user_b' }),
        claimRow({ _id: new Types.ObjectId(), userId: 'user_c' }),
      ]),
    );
    claimModel.updateOne
      .mockReturnValueOnce(modified(1)) // the approval
      .mockReturnValueOnce({
        exec: () => Promise.reject(new Error('write down')),
      })
      .mockReturnValueOnce(modified(1)); // the next one is still tried
    await expect(service.approve(ADMIN, String(CLAIM_ID))).resolves.toEqual({
      approved: true,
    });
    expect(claimModel.updateOne).toHaveBeenCalledTimes(4);
    expect(session.endSession).toHaveBeenCalled();
    expect(jest.spyOn(Logger.prototype, 'warn')).toHaveBeenCalledWith(
      expect.stringMatching(/Could not list the other requests/),
    );
    expect(jest.spyOn(Logger.prototype, 'warn')).toHaveBeenCalledWith(
      expect.stringMatching(/Could not reject request .* write down/),
    );
  });

  it('a request inserted after the page was bound is rejected by the site at once', async () => {
    const { service, profileModel, claimModel, log } = build();
    // First the claimant's own page (none), then the page, now owned.
    profileModel.findOne
      .mockReturnValueOnce(chain(null))
      .mockReturnValueOnce(chain({ ownerUserId: 'user_b' }));
    const view = await service.request(viewer, 'imported-page', 'Mine.');
    expect(view).toMatchObject({
      status: 'rejected',
      reason: SITE_REASON_TAKEN,
      decidedAt: expect.any(String) as unknown,
    });
    const [filter, update] = claimModel.updateOne.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(filter).toEqual({ _id: CLAIM_ID, status: 'pending' });
    expect(update.$set).toMatchObject({
      status: 'rejected',
      decidedBy: SYSTEM_CLAIMS_ACTOR,
    });
    expect(log.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'claim.rejected' }),
      expect.anything(),
    );
  });

  it('leaves that request pending when it was decided meanwhile, or the rejection fails', async () => {
    const { service, profileModel, claimModel } = build();
    // First the claimant's own page (none), then the page, now owned.
    profileModel.findOne
      .mockReturnValueOnce(chain(null))
      .mockReturnValueOnce(chain({ ownerUserId: 'user_b' }));
    claimModel.updateOne.mockReturnValueOnce(modified(0));
    expect(
      (await service.request(viewer, 'imported-page', 'Mine.')).status,
    ).toBe('pending');
    // First the claimant's own page (none), then the page, now owned.
    profileModel.findOne
      .mockReturnValueOnce(chain(null))
      .mockReturnValueOnce(chain({ ownerUserId: 'user_b' }));
    claimModel.updateOne.mockReturnValueOnce({
      // Not an Error on purpose: the log line must still read.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      exec: () => Promise.reject('odd'),
    });
    expect(
      (await service.request(viewer, 'imported-page', 'Mine.')).status,
    ).toBe('pending');
    expect(jest.spyOn(Logger.prototype, 'warn')).toHaveBeenCalledWith(
      expect.stringMatching(/Could not reject request .* odd/),
    );
  });

  it('answers 503, plainly, when the database cannot run transactions', async () => {
    const { service, session } = build();
    const standalone = Object.assign(
      new Error(
        'Transaction numbers are only allowed on a replica set member or mongos',
      ),
      { code: 20 },
    );
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    for (const decide of [
      () => service.approve(ADMIN, String(CLAIM_ID)),
      () => service.reject(ADMIN, String(CLAIM_ID)),
      () => service.withdraw(CLAIMANT, String(CLAIM_ID)),
    ]) {
      session.withTransaction.mockRejectedValueOnce(standalone);
      await expect(decide()).rejects.toThrow(
        new ServiceUnavailableException(CLAIMS_NEED_REPLICA_SET),
      );
    }
    expect(error).toHaveBeenCalledTimes(3);
  });

  it('recognises an unsupported transaction by its code or its words only', () => {
    expect(isTransactionUnsupported({ code: 20 })).toBe(true);
    expect(
      isTransactionUnsupported(
        new Error('This MongoDB deployment does not support retryable writes.'),
      ),
    ).toBe(true);
    expect(
      isTransactionUnsupported(
        new Error(
          'Transaction numbers are only allowed on a replica set member or mongos',
        ),
      ),
    ).toBe(true);
    expect(isTransactionUnsupported(new Error('E11000'))).toBe(false);
    expect(isTransactionUnsupported({ code: 11000, message: 1 })).toBe(false);
    expect(isTransactionUnsupported(null)).toBe(false);
    expect(isTransactionUnsupported('odd')).toBe(false);
  });
});

describe('ClaimsService: emails (Chunk 14)', () => {
  const notifier = () => ({
    adminNotice: jest.fn(() => Promise.resolve()),
    claimDecided: jest.fn(() => Promise.resolve()),
  });
  const decisions = (n: ReturnType<typeof notifier>) =>
    n.claimDecided.mock.calls.map((call) => {
      const [event] = call as unknown as [
        { claimantUserId: string; approved: boolean; actorUserId: string },
      ];
      return [event.claimantUserId, event.approved, event.actorUserId];
    });

  it('tells the admins of a new request, but not of one the site rejected at once', async () => {
    const n = notifier();
    const { service, profileModel } = build(n);
    await service.request(viewer, 'imported-page', 'Mine.');
    expect(n.adminNotice).toHaveBeenCalledWith({
      kind: 'admin-claim-requested',
      subjectUserId: CLAIMANT,
      actorUserId: CLAIMANT,
      once: `claim:${String(CLAIM_ID)}`,
      refs: { claimId: String(CLAIM_ID), profileId: PROFILE_ID },
    });
    profileModel.findOne
      .mockReturnValueOnce(chain(null))
      .mockReturnValueOnce(chain({ ownerUserId: 'user_b' }));
    await service.request(viewer, 'imported-page', 'Mine.');
    expect(n.adminNotice).toHaveBeenCalledTimes(1);
    expect(n.claimDecided).not.toHaveBeenCalled();
  });

  it('tells the claimant an approval, and each other claimant the site’s rejection', async () => {
    const n = notifier();
    const { service, claimModel } = build(n);
    claimModel.find.mockReturnValueOnce(
      chain([
        claimRow({ _id: OTHER_CLAIM_ID, userId: 'user_b' }),
        claimRow({ _id: new Types.ObjectId(), userId: 'user_c' }),
      ]),
    );
    claimModel.updateOne
      .mockReturnValueOnce(modified(1)) // the approval
      .mockReturnValueOnce(modified(1)) // user_b rejected
      .mockReturnValueOnce(modified(0)); // user_c decided meanwhile
    await service.approve(ADMIN, String(CLAIM_ID));
    expect(decisions(n)).toEqual([
      [CLAIMANT, true, ADMIN],
      ['user_b', false, SYSTEM_CLAIMS_ACTOR],
    ]);
    expect(n.claimDecided).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: String(CLAIM_ID),
        profileId: PROFILE_ID,
      }),
    );
  });

  it('tells the claimant when the page was taken meanwhile, only if the site rejected it', async () => {
    const n = notifier();
    const { service, profileModel, claimModel } = build(n);
    profileModel.updateOne.mockReturnValue(modified(0));
    profileModel.findOne.mockReturnValueOnce(chain({}));
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      PAGE_TAKEN,
    );
    expect(decisions(n)).toEqual([[CLAIMANT, false, ADMIN]]);
    profileModel.findOne.mockReturnValueOnce(chain({}));
    claimModel.updateOne
      .mockReturnValueOnce(modified(1))
      .mockReturnValueOnce(modified(0));
    await expect(service.approve(ADMIN, String(CLAIM_ID))).rejects.toThrow(
      PAGE_TAKEN,
    );
    expect(n.claimDecided).toHaveBeenCalledTimes(1);
  });

  it('tells the claimant a rejection, and nobody a withdrawal', async () => {
    const n = notifier();
    const { service } = build(n);
    await service.reject(ADMIN, String(CLAIM_ID), 'Synthetic reason');
    expect(decisions(n)).toEqual([[CLAIMANT, false, ADMIN]]);
    await service.withdraw(CLAIMANT, String(CLAIM_ID));
    expect(n.claimDecided).toHaveBeenCalledTimes(1);
  });
});
