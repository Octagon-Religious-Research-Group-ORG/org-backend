import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createClerkClient } from '@clerk/backend';
import { ClerkUserInfoService } from './clerk-user-info.service';

jest.mock('@clerk/backend', () => ({
  createClerkClient: jest.fn(),
}));

const createClerkClientMock = jest.mocked(createClerkClient);
const getUser = jest.fn();

const config = {
  getOrThrow: jest.fn(() => 'sk_test_secret'),
};

function build(): ClerkUserInfoService {
  createClerkClientMock.mockReturnValue({
    users: { getUser },
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
  ])('returns undefined when %s', async (_label, overrides) => {
    getUser.mockResolvedValue(user(overrides));

    await expect(build().getIdentity('user_123')).resolves.toBeUndefined();
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
});
