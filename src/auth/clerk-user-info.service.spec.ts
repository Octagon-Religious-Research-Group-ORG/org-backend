import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createClerkClient } from '@clerk/backend';
import {
  CLERK_READ_UNAVAILABLE,
  CLERK_TIMED_OUT,
  CLERK_TIMEOUT_MS,
  ClerkOutcomeUnknown,
  ClerkTimedOut,
  ClerkUserInfoService,
  withClerkTimeout,
} from './clerk-user-info.service';

jest.mock('@clerk/backend', () => ({
  createClerkClient: jest.fn(),
}));

const createClerkClientMock = jest.mocked(createClerkClient);
const getUser = jest.fn();
const updateUserMetadata = jest.fn();

const config = {
  getOrThrow: jest.fn(() => 'sk_test_secret'),
};

function build(): ClerkUserInfoService {
  createClerkClientMock.mockReturnValue({
    users: { getUser, updateUserMetadata },
  } as never);
  return new ClerkUserInfoService(config as never);
}

function user(overrides: Record<string, unknown> = {}) {
  return {
    primaryEmailAddressId: 'idn_primary',
    emailAddresses: [
      {
        id: 'idn_primary',
        emailAddress: '  Member@Example.ORG  ',
        verification: { status: 'verified' },
      },
    ],
    ...overrides,
  };
}

describe('ClerkUserInfoService', () => {
  beforeEach(() => {
    createClerkClientMock.mockReset();
    getUser.mockReset();
    updateUserMetadata.mockReset();
    config.getOrThrow.mockClear();
  });

  it('builds the Clerk client from the configured secret key', () => {
    build();

    expect(config.getOrThrow).toHaveBeenCalledWith('CLERK_SECRET_KEY');
    expect(createClerkClientMock).toHaveBeenCalledWith({
      secretKey: 'sk_test_secret',
    });
  });

  it('returns the normalised primary email for a verified member', async () => {
    getUser.mockResolvedValue(user());

    await expect(build().getIdentity('user_123')).resolves.toEqual({
      email: 'member@example.org',
      emailVerified: true,
    });
    expect(getUser).toHaveBeenCalledWith('user_123');
  });

  it.each([
    ['an unverified address', { status: 'unverified' }],
    ['a missing verification record', undefined],
  ])('reports emailVerified false for %s', async (_label, verification) => {
    getUser.mockResolvedValue(
      user({
        emailAddresses: [
          {
            id: 'idn_primary',
            emailAddress: 'member@example.org',
            verification,
          },
        ],
      }),
    );

    await expect(build().getIdentity('user_123')).resolves.toEqual({
      email: 'member@example.org',
      emailVerified: false,
    });
  });

  it.each([
    [
      'no address matches the primary id',
      {
        emailAddresses: [
          {
            id: 'idn_other',
            emailAddress: 'member@example.org',
            verification: { status: 'verified' },
          },
        ],
      },
    ],
    [
      'the primary address is blank',
      {
        emailAddresses: [
          {
            id: 'idn_primary',
            emailAddress: '   ',
            verification: { status: 'verified' },
          },
        ],
      },
    ],
  ])('returns no email when %s', async (_label, overrides) => {
    getUser.mockResolvedValue(user(overrides));

    await expect(build().getIdentity('user_123')).resolves.toEqual({
      emailVerified: false,
    });
  });

  it('rejects an unknown member as unauthorized', async () => {
    getUser.mockRejectedValue({ status: 404 });

    await expect(build().getIdentity('user_missing')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each([
    ['a non-object failure', 'boom'],
    ['a null failure', null],
    ['an object without a status', new Error('network down')],
    ['a non-404 status', { status: 500 }],
  ])('treats %s as a temporary outage', async (_label, thrown) => {
    getUser.mockRejectedValue(thrown);

    await expect(build().getIdentity('user_123')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('reads the role from public metadata', async () => {
    getUser.mockResolvedValue(user({ publicMetadata: { role: 'admin' } }));

    await expect(build().getIdentity('user_123')).resolves.toEqual({
      email: 'member@example.org',
      emailVerified: true,
      role: 'admin',
    });
  });

  it('returns the role of a username-only account with no email', async () => {
    getUser.mockResolvedValue(
      user({ emailAddresses: [], publicMetadata: { role: 'moderator' } }),
    );

    await expect(build().getIdentity('user_123')).resolves.toEqual({
      emailVerified: false,
      role: 'moderator',
    });
  });

  it.each([['moderator' as const], [null]])(
    'writes role %s to public metadata',
    async (role) => {
      updateUserMetadata.mockResolvedValue({});

      await build().setRole('user_123', role);

      expect(updateUserMetadata).toHaveBeenCalledWith('user_123', {
        publicMetadata: { role },
      });
    },
  );

  it.each([
    ['an unknown member', { status: 404 }, UnauthorizedException],
    ['an outage', new Error('down'), ServiceUnavailableException],
  ])('translates a failed role write for %s', async (_label, thrown, type) => {
    updateUserMetadata.mockRejectedValue(thrown);

    await expect(build().setRole('user_123', 'admin')).rejects.toBeInstanceOf(
      type,
    );
  });
});

describe('Clerk timeouts (Chunk 12, review round 2)', () => {
  afterEach(() => jest.useRealTimers());

  it('stops waiting for a Clerk call that hangs, and says the service is unavailable', async () => {
    jest.useFakeTimers();
    getUser.mockReturnValue(new Promise(() => undefined));
    updateUserMetadata.mockReturnValue(new Promise(() => undefined));
    const service = build();
    const read = service.getIdentity('user_1').catch((e: unknown) => e);
    const write = service.setRole('user_1', null).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(CLERK_TIMEOUT_MS + 1);
    expect(await read).toBeInstanceOf(ServiceUnavailableException);
    expect(await write).toBeInstanceOf(ServiceUnavailableException);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('passes its own timeouts through unchanged: a read stays a read, a write stays unknown (round 4)', async () => {
    jest.useFakeTimers();
    getUser.mockReturnValue(new Promise(() => undefined));
    updateUserMetadata.mockReturnValue(new Promise(() => undefined));
    const service = build();
    const read = service.getIdentity('user_1').catch((e: unknown) => e);
    const write = service.setRole('user_1', null).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(CLERK_TIMEOUT_MS + 1);
    // Not rewritten as "temporarily unavailable" by the read translation.
    expect(await read).toEqual(
      new ServiceUnavailableException(CLERK_READ_UNAVAILABLE),
    );
    expect(await read).not.toBeInstanceOf(ClerkOutcomeUnknown);
    expect(await write).toBeInstanceOf(ClerkTimedOut);
    expect(((await write) as Error).message).toBe(CLERK_TIMED_OUT);
  });

  it('leaves no timer behind when Clerk answers', async () => {
    jest.useFakeTimers();
    await expect(withClerkTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
    expect(jest.getTimerCount()).toBe(0);
  });
});
