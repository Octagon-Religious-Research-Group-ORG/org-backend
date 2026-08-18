import { AdminAccessService } from './admin-access.service';
import type { AuthenticatedRequest } from './auth.types';
import { createHash } from 'node:crypto';

function query<T>(value: T) {
  const chain = {
    lean: jest.fn(),
    exec: jest.fn().mockResolvedValue(value),
  };
  chain.lean.mockReturnValue(chain);
  return chain;
}

const ACCESS_TOKEN_HASH = createHash('sha256')
  .update('Bearer access-token')
  .digest('hex');

function request(withAccessToken = true) {
  return {
    auth: {
      payload: {
        sub: 'user_member',
      },
    },
    headers: withAccessToken ? { authorization: 'Bearer access-token' } : {},
  } as AuthenticatedRequest;
}

describe('AdminAccessService', () => {
  const config = {
    get: jest.fn(() => ' other@example.test; ADMIN@example.test '),
  };

  beforeEach(() => {
    config.get.mockClear();
  });

  it('synchronizes a verified allowlisted identity as an administrator', async () => {
    const profile = {
      authProviderId: 'user_member',
      authEmail: 'admin@example.test',
      authEmailVerified: true,
      authEmailTokenHash: ACCESS_TOKEN_HASH,
      isAdmin: true,
    };
    const identity = {
      getIdentity: jest.fn().mockResolvedValue({
        email: ' ADMIN@EXAMPLE.TEST ',
        emailVerified: true,
      }),
    };
    const updateQuery = query(profile);
    const model = {
      findOneAndUpdate: jest.fn(() => updateQuery),
    };
    const service = new AdminAccessService(
      config as never,
      identity as never,
      model as never,
    );

    await expect(service.synchronizeProfile(request())).resolves.toBe(profile);
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { authProviderId: 'user_member' },
      {
        $setOnInsert: {
          authProviderId: 'user_member',
          email: 'admin@example.test',
        },
        $set: {
          authEmail: 'admin@example.test',
          authEmailVerified: true,
          authEmailTokenHash: ACCESS_TOKEN_HASH,
          isAdmin: true,
        },
      },
      {
        returnDocument: 'after',
        upsert: true,
        setDefaultsOnInsert: true,
      },
    );
  });

  it('stores unverified identity email without granting administrator access', async () => {
    const identity = {
      getIdentity: jest.fn().mockResolvedValue({
        email: 'admin@example.test',
        emailVerified: false,
      }),
    };
    const updateQuery = query({ isAdmin: false });
    const model = {
      findOneAndUpdate: jest.fn(() => updateQuery),
    };
    const service = new AdminAccessService(
      config as never,
      identity as never,
      model as never,
    );

    await expect(service.synchronizeProfile(request(false))).resolves.toEqual({
      isAdmin: false,
    });
    expect(model.findOneAndUpdate.mock.calls[0][1]).toEqual({
      $setOnInsert: {
        authProviderId: 'user_member',
        email: 'admin@example.test',
      },
      $set: {
        authEmail: 'admin@example.test',
        authEmailVerified: false,
        isAdmin: false,
      },
      $unset: { authEmailTokenHash: 1 },
    });
  });

  it('clears stale identity fields when Auth0 supplies no email', async () => {
    const identity = {
      getIdentity: jest.fn().mockResolvedValue(undefined),
    };
    const updateQuery = query({ isAdmin: false });
    const model = {
      findOneAndUpdate: jest.fn(() => updateQuery),
    };
    const service = new AdminAccessService(
      { get: jest.fn(() => undefined) } as never,
      identity as never,
      model as never,
    );

    await service.synchronizeProfile(request(false));

    expect(model.findOneAndUpdate.mock.calls[0][1]).toEqual({
      $setOnInsert: { authProviderId: 'user_member' },
      $set: {
        authEmailVerified: false,
        isAdmin: false,
      },
      $unset: {
        authEmail: 1,
        authEmailTokenHash: 1,
      },
    });
  });

  it('uses a profile synchronized for the current access token', async () => {
    const findQuery = query({
      authEmail: 'ADMIN@example.test',
      authEmailVerified: true,
      isAdmin: true,
    });
    const model = {
      findOne: jest.fn(() => findQuery),
      updateOne: jest.fn(),
    };
    const identity = { getIdentity: jest.fn() };
    const service = new AdminAccessService(
      config as never,
      identity as never,
      model as never,
    );

    await expect(service.hasAdminAccess(request())).resolves.toBe(true);
    expect(model.findOne).toHaveBeenCalledWith({
      authProviderId: 'user_member',
      authEmailTokenHash: ACCESS_TOKEN_HASH,
    });
    expect(identity.getIdentity).not.toHaveBeenCalled();
    expect(model.updateOne).not.toHaveBeenCalled();
  });

  it('revokes a stale stored administrator flag when the email is not allowlisted', async () => {
    const findQuery = query({
      authEmail: 'member@example.test',
      authEmailVerified: true,
      isAdmin: true,
    });
    const updateQuery = {
      exec: jest.fn().mockResolvedValue(undefined),
    };
    const model = {
      findOne: jest.fn(() => findQuery),
      updateOne: jest.fn(() => updateQuery),
    };
    const service = new AdminAccessService(
      config as never,
      {} as never,
      model as never,
    );

    await expect(service.hasAdminAccess(request())).resolves.toBe(false);
    expect(model.updateOne).toHaveBeenCalledWith(
      { authProviderId: 'user_member' },
      { $set: { isAdmin: false } },
    );
  });

  it.each([
    ['a new token', request(), true],
    ['a request without an access token', request(false), false],
  ])(
    'synchronizes Auth0 identity for %s',
    async (_name, memberRequest, queryCurrentProfile) => {
      const currentQuery = query(null);
      const synchronizedQuery = query({ isAdmin: true });
      const model = {
        findOne: jest.fn(() => currentQuery),
        findOneAndUpdate: jest.fn(() => synchronizedQuery),
      };
      const identity = {
        getIdentity: jest.fn().mockResolvedValue({
          email: 'admin@example.test',
          emailVerified: true,
        }),
      };
      const service = new AdminAccessService(
        config as never,
        identity as never,
        model as never,
      );

      await expect(service.hasAdminAccess(memberRequest)).resolves.toBe(true);
      expect(model.findOne).toHaveBeenCalledTimes(queryCurrentProfile ? 1 : 0);
      expect(identity.getIdentity).toHaveBeenCalled();
    },
  );

  it('denies access when synchronization does not return an admin profile', async () => {
    const model = {
      findOneAndUpdate: jest.fn(() => query(null)),
    };
    const identity = {
      getIdentity: jest.fn().mockResolvedValue({
        email: 'member@example.test',
        emailVerified: true,
      }),
    };
    const service = new AdminAccessService(
      config as never,
      identity as never,
      model as never,
    );

    await expect(service.hasAdminAccess(request(false))).resolves.toBe(false);
  });
});
