/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.any() is typed any */
import { Logger } from '@nestjs/common';
import {
  AdminAccessService,
  MAX_REMEMBERED_READ_ANSWERS,
  MAX_SHARED_READ_LOOKUP_MS,
  ROLE_CACHE_MAX_AGE_MS,
} from './admin-access.service';
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
      findOneAndUpdate: jest.fn<unknown, any[]>(() => updateQuery),
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
          authRoleCheckedAt: expect.any(Date),
          isAdmin: true,
        },
        $unset: { authRole: 1 },
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
      findOneAndUpdate: jest.fn<unknown, any[]>(() => updateQuery),
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
        authRoleCheckedAt: expect.any(Date),
        isAdmin: false,
      },
      $unset: { authRole: 1, authEmailTokenHash: 1 },
    });
  });

  it('clears stale identity fields when Clerk supplies no email', async () => {
    const identity = {
      getIdentity: jest.fn().mockResolvedValue({ emailVerified: false }),
    };
    const updateQuery = query({ isAdmin: false });
    const model = {
      findOneAndUpdate: jest.fn<unknown, any[]>(() => updateQuery),
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
        authRoleCheckedAt: expect.any(Date),
        isAdmin: false,
      },
      $unset: {
        authEmail: 1,
        authRole: 1,
        authEmailTokenHash: 1,
      },
    });
  });

  it('uses a profile synchronized for the current access token', async () => {
    const findQuery = query({
      authEmail: 'ADMIN@example.test',
      authEmailVerified: true,
      authRoleCheckedAt: new Date(),
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
      authRoleCheckedAt: new Date(),
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
    'synchronizes Clerk identity for %s',
    async (_name, memberRequest, queryCurrentProfile) => {
      const currentQuery = query(null);
      const synchronizedQuery = query({ isAdmin: true });
      const model = {
        findOne: jest.fn(() => currentQuery),
        findOneAndUpdate: jest.fn<unknown, any[]>(() => synchronizedQuery),
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
      findOneAndUpdate: jest.fn<unknown, any[]>(() => query(null)),
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

  describe('Clerk roles', () => {
    let warn: jest.SpyInstance;

    beforeEach(() => {
      warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
    });

    afterEach(() => warn.mockRestore());

    it('grants admin from the Clerk role alone and caches the role', async () => {
      const identity = {
        getIdentity: jest
          .fn()
          .mockResolvedValue({ emailVerified: false, role: 'admin' }),
      };
      const model = {
        findOneAndUpdate: jest.fn<unknown, any[]>(() =>
          query({ isAdmin: true }),
        ),
      };
      const service = new AdminAccessService(
        { get: jest.fn(() => '') } as never,
        identity as never,
        model as never,
      );

      await service.synchronizeProfile(request(false));

      expect(model.findOneAndUpdate.mock.calls[0][1]).toMatchObject({
        $set: { authRole: 'admin', isAdmin: true },
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('sends no $unset when email, role and token are all present', async () => {
      const identity = {
        getIdentity: jest.fn().mockResolvedValue({
          email: 'admin@example.test',
          emailVerified: true,
          role: 'admin',
        }),
      };
      const model = {
        findOneAndUpdate: jest.fn<unknown, any[]>(() =>
          query({ isAdmin: true }),
        ),
      };
      const service = new AdminAccessService(
        config as never,
        identity as never,
        model as never,
      );

      await service.synchronizeProfile(request());

      expect(model.findOneAndUpdate.mock.calls[0][1]).not.toHaveProperty(
        '$unset',
      );
    });

    it('does not grant admin for the moderator role', async () => {
      const identity = {
        getIdentity: jest
          .fn()
          .mockResolvedValue({ emailVerified: false, role: 'moderator' }),
      };
      const model = {
        findOneAndUpdate: jest.fn<unknown, any[]>(() =>
          query({ isAdmin: false }),
        ),
      };
      const service = new AdminAccessService(
        { get: jest.fn(() => '') } as never,
        identity as never,
        model as never,
      );

      await service.synchronizeProfile(request(false));

      expect(model.findOneAndUpdate.mock.calls[0][1]).toMatchObject({
        $set: { authRole: 'moderator', isAdmin: false },
      });
    });

    it('trusts a cached admin role for the current token', async () => {
      const model = {
        findOne: jest.fn(() =>
          query({
            authRole: 'admin',
            authEmailVerified: false,
            authRoleCheckedAt: new Date(),
            isAdmin: true,
          }),
        ),
        updateOne: jest.fn(),
      };
      const service = new AdminAccessService(
        { get: jest.fn(() => '') } as never,
        { getIdentity: jest.fn() } as never,
        model as never,
      );

      await expect(service.hasAdminAccess(request())).resolves.toBe(true);
      expect(model.updateOne).not.toHaveBeenCalled();
    });

    it('warns once per member when only the allowlist grants admin', async () => {
      const model = {
        findOne: jest.fn(() =>
          query({
            authEmail: 'admin@example.test',
            authEmailVerified: true,
            authRoleCheckedAt: new Date(),
            isAdmin: true,
          }),
        ),
        updateOne: jest.fn(),
      };
      const service = new AdminAccessService(
        config as never,
        { getIdentity: jest.fn() } as never,
        model as never,
      );

      await service.hasAdminAccess(request());
      await service.hasAdminAccess(request());

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('user_member'));
    });
  });
});

describe('isAdminForRead', () => {
  const config = { get: jest.fn(() => 'list@example.test') };
  function setup(identity: Record<string, unknown>) {
    const clerk = { getIdentity: jest.fn().mockResolvedValue(identity) };
    const model = {
      findOne: jest.fn(() => query(null)),
      findOneAndUpdate: jest.fn(() => query(null)),
      updateOne: jest.fn(() => ({ exec: jest.fn() })),
    };
    const service = new AdminAccessService(
      config as never,
      clerk as never,
      model as never,
    );
    return { service, clerk, model };
  }
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => {
    warn.mockRestore();
    jest.useRealTimers();
  });

  it('reads the Clerk role and writes no row', async () => {
    const { service, model } = setup({ emailVerified: false, role: 'admin' });
    await expect(service.isAdminForRead(request())).resolves.toBe(true);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    expect(model.updateOne).not.toHaveBeenCalled();
    expect(model.findOne).not.toHaveBeenCalled();
  });

  it('answers no for a member without the role', async () => {
    const { service } = setup({ emailVerified: false, role: 'moderator' });
    await expect(service.isAdminForRead(request())).resolves.toBe(false);
  });

  it('honours the verified allowlist, normalising the address', async () => {
    const { service } = setup({
      email: ' LIST@example.test ',
      emailVerified: true,
    });
    await expect(service.isAdminForRead(request())).resolves.toBe(true);
  });

  it('treats an unknown verified flag as unverified', async () => {
    const { service } = setup({ email: 'list@example.test' });
    await expect(service.isAdminForRead(request())).resolves.toBe(false);
  });

  it('copes with an identity that has no address', async () => {
    const { service } = setup({ emailVerified: true });
    await expect(service.isAdminForRead(request())).resolves.toBe(false);
  });

  it('asks Clerk once per token until the answer is too old', async () => {
    jest.useFakeTimers();
    const { service, clerk } = setup({ emailVerified: true, role: 'admin' });
    await service.isAdminForRead(request());
    await service.isAdminForRead(request());
    expect(clerk.getIdentity).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(ROLE_CACHE_MAX_AGE_MS + 1);
    await service.isAdminForRead(request());
    expect(clerk.getIdentity).toHaveBeenCalledTimes(2);
  });

  it('asks Clerk every time when there is no token to key on', async () => {
    const { service, clerk } = setup({ emailVerified: true });
    await service.isAdminForRead(request(false));
    await service.isAdminForRead(request(false));
    expect(clerk.getIdentity).toHaveBeenCalledTimes(2);
  });

  describe('a lookup already on its way', () => {
    function deferred<T>() {
      let resolve: (value: T) => void = () => undefined;
      let reject: (error: unknown) => void = () => undefined;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }
    const admin = { emailVerified: true, role: 'admin' };

    it('is shared by everyone asking with the same token', async () => {
      const { service, clerk } = setup(admin);
      const first = deferred<unknown>();
      clerk.getIdentity.mockReturnValueOnce(first.promise);

      const asked = Array.from({ length: 5 }, () =>
        service.isAdminForRead(request()),
      );
      expect(clerk.getIdentity).toHaveBeenCalledTimes(1);
      first.resolve(admin);
      await expect(Promise.all(asked)).resolves.toEqual(Array(5).fill(true));

      await service.isAdminForRead(request());
      expect(clerk.getIdentity).toHaveBeenCalledTimes(1);
    });

    it('is not shared between different tokens', async () => {
      const { service, clerk } = setup(admin);
      const forToken = (token: string) =>
        ({
          auth: { payload: { sub: 'u1' } },
          headers: { authorization: `Bearer ${token}` },
        }) as AuthenticatedRequest;
      await Promise.all([
        service.isAdminForRead(forToken('a')),
        service.isAdminForRead(forToken('b')),
      ]);
      expect(clerk.getIdentity).toHaveBeenCalledTimes(2);
    });

    it('fails for those who shared it, and is forgotten', async () => {
      const { service, clerk } = setup(admin);
      const first = deferred<unknown>();
      clerk.getIdentity.mockReturnValueOnce(first.promise);
      const asked = [
        service.isAdminForRead(request()),
        service.isAdminForRead(request()),
      ];
      first.reject(new Error('clerk down'));
      await expect(Promise.all(asked)).rejects.toThrow('clerk down');

      await expect(service.isAdminForRead(request())).resolves.toBe(true);
      expect(clerk.getIdentity).toHaveBeenCalledTimes(2);
    });

    it('never remembers a failure as an answer', async () => {
      const { service, clerk } = setup(admin);
      clerk.getIdentity.mockRejectedValueOnce(new Error('clerk down'));
      await expect(service.isAdminForRead(request())).rejects.toThrow();
      await expect(service.isAdminForRead(request())).resolves.toBe(true);
    });

    it('stops being shared once it has hung too long', async () => {
      jest.useFakeTimers();
      const { service, clerk } = setup(admin);
      clerk.getIdentity.mockReturnValueOnce(new Promise(() => undefined));
      void service.isAdminForRead(request());
      expect(clerk.getIdentity).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(MAX_SHARED_READ_LOOKUP_MS + 1);
      await expect(service.isAdminForRead(request())).resolves.toBe(true);
      expect(clerk.getIdentity).toHaveBeenCalledTimes(2);
    });

    it('holds a bounded number of hung lookups, dropping the oldest', () => {
      const { service, clerk } = setup(admin);
      clerk.getIdentity.mockReturnValue(new Promise(() => undefined));
      const forToken = (token: string) =>
        ({
          auth: { payload: { sub: 'u1' } },
          headers: { authorization: `Bearer ${token}` },
        }) as AuthenticatedRequest;
      for (let i = 0; i <= MAX_REMEMBERED_READ_ANSWERS; i++) {
        void service.isAdminForRead(forToken(String(i)));
      }
      const calls = clerk.getIdentity.mock.calls.length;
      void service.isAdminForRead(
        forToken(String(MAX_REMEMBERED_READ_ANSWERS)),
      );
      expect(clerk.getIdentity).toHaveBeenCalledTimes(calls);
      void service.isAdminForRead(forToken('0'));
      expect(clerk.getIdentity).toHaveBeenCalledTimes(calls + 1);
    });

    it('a late result cannot replace a newer answer', async () => {
      jest.useFakeTimers();
      const { service, clerk } = setup(admin);
      const stale = deferred<unknown>();
      clerk.getIdentity
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValueOnce({ emailVerified: true });
      const old = service.isAdminForRead(request());
      jest.advanceTimersByTime(MAX_SHARED_READ_LOOKUP_MS + 1);
      await expect(service.isAdminForRead(request())).resolves.toBe(false);

      stale.resolve(admin);
      await expect(old).resolves.toBe(true);

      await expect(service.isAdminForRead(request())).resolves.toBe(false);
      expect(clerk.getIdentity).toHaveBeenCalledTimes(2);
    });

    it('a stale lookup finishing cannot remove the one that replaced it', async () => {
      jest.useFakeTimers();
      const { service, clerk } = setup(admin);
      const stale = deferred<unknown>();
      const current = deferred<unknown>();
      clerk.getIdentity
        .mockReturnValueOnce(stale.promise)
        .mockReturnValueOnce(current.promise);
      const old = service.isAdminForRead(request());
      jest.advanceTimersByTime(MAX_SHARED_READ_LOOKUP_MS + 1);
      const replacement = service.isAdminForRead(request());
      stale.reject(new Error('late'));
      await expect(old).rejects.toThrow('late');

      const third = service.isAdminForRead(request());
      expect(clerk.getIdentity).toHaveBeenCalledTimes(2);
      current.resolve(admin);
      await expect(replacement).resolves.toBe(true);
      await expect(third).resolves.toBe(true);
    });
  });

  it('holds a bounded number of answers, dropping the oldest', async () => {
    const { service, clerk } = setup({ emailVerified: true });
    const forToken = (token: string) =>
      ({
        auth: { payload: { sub: 'u1' } },
        headers: { authorization: `Bearer ${token}` },
      }) as AuthenticatedRequest;
    for (let i = 0; i <= MAX_REMEMBERED_READ_ANSWERS; i++) {
      await service.isAdminForRead(forToken(String(i)));
    }
    const calls = clerk.getIdentity.mock.calls.length;
    await service.isAdminForRead(forToken(String(MAX_REMEMBERED_READ_ANSWERS)));
    expect(clerk.getIdentity).toHaveBeenCalledTimes(calls);
    await service.isAdminForRead(forToken('0'));
    expect(clerk.getIdentity).toHaveBeenCalledTimes(calls + 1);
  });
});

describe('how long a cached role is trusted', () => {
  const NOW = new Date('2026-11-08T12:00:00.000Z').getTime();
  const config = { get: jest.fn(() => '') };

  function setup(checkedAt: Date | undefined) {
    const cached = {
      authProviderId: 'user_member',
      authRole: 'admin',
      authEmailVerified: true,
      isAdmin: true,
      authRoleCheckedAt: checkedAt,
    };
    // Clerk no longer lists the role, which is what a removal looks like.
    const identity = {
      getIdentity: jest.fn().mockResolvedValue({ emailVerified: true }),
    };
    const model = {
      findOne: jest.fn(() => query(cached)),
      updateOne: jest.fn(() => query({})),
      findOneAndUpdate: jest.fn(() => query({ isAdmin: false })),
    };
    const service = new AdminAccessService(
      config as never,
      identity as never,
      model as never,
    );
    return { service, identity };
  }

  beforeEach(() => jest.useFakeTimers({ now: NOW }));
  afterEach(() => jest.useRealTimers());

  it('uses the cache inside the limit, without asking Clerk', async () => {
    const { service, identity } = setup(
      new Date(NOW - ROLE_CACHE_MAX_AGE_MS + 1),
    );
    await expect(service.hasAdminAccess(request())).resolves.toBe(true);
    expect(identity.getIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ['at the limit', new Date(NOW - ROLE_CACHE_MAX_AGE_MS)],
    ['never checked', undefined],
  ])('re-reads Clerk when %s, so a removed role ends', async (_case, at) => {
    const { service, identity } = setup(at);
    await expect(service.hasAdminAccess(request())).resolves.toBe(false);
    expect(identity.getIdentity).toHaveBeenCalledWith('user_member');
  });
});
