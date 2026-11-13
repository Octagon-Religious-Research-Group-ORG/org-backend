import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createClerkClient } from '@clerk/backend';
import {
  CLERK_READ_UNAVAILABLE,
  CLERK_TIMEOUT_MS,
  ClerkOutcomeUnknown,
} from './clerk-user-info.service';
import {
  ALREADY_INVITED,
  CLERK_PAGE,
  CLERK_UNAVAILABLE,
  CLERK_WRITE_REFUSED_HERE,
  ClerkAdminDirectoryService,
  INVITATION_NOT_FOUND,
  INVITATION_REFUSED,
  MAX_INVITATION_PAGES,
  MAX_USER_PAGES,
  translate,
} from './clerk-admin-directory.service';

jest.mock('@clerk/backend', () => ({ createClerkClient: jest.fn() }));

const getUserList = jest.fn();
const createInvitation = jest.fn();
const getInvitationList = jest.fn();
const revokeInvitation = jest.fn();

function build() {
  jest.mocked(createClerkClient).mockReturnValue({
    users: { getUserList },
    invitations: { createInvitation, getInvitationList, revokeInvitation },
  } as never);
  return new ClerkAdminDirectoryService({
    getOrThrow: () => 'sk_test_secret',
  } as never);
}

const user = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  publicMetadata: {},
  primaryEmailAddressId: 'e1',
  emailAddresses: [{ id: 'e1', emailAddress: `${id}@Example.org` }],
  firstName: null,
  lastName: null,
  username: null,
  ...overrides,
});

const CREATED = Date.UTC(2026, 10, 13);

describe('ClerkAdminDirectoryService', () => {
  beforeEach(() => {
    getUserList.mockReset();
    createInvitation.mockReset();
    getInvitationList.mockReset();
    revokeInvitation.mockReset();
  });

  describe('holdersOf', () => {
    it('reads every page and keeps only the holders of the role', async () => {
      const full = Array.from({ length: CLERK_PAGE }, (_, i) =>
        user(`user_${i}`),
      );
      full[3] = user('user_a', {
        publicMetadata: { role: 'admin' },
        firstName: 'Synthetic',
        lastName: 'Admin',
      });
      getUserList.mockResolvedValueOnce({ data: full }).mockResolvedValueOnce({
        data: [
          user('user_b', {
            publicMetadata: { role: 'admin' },
            username: 'second',
            primaryEmailAddressId: null,
          }),
          user('user_c', { publicMetadata: { role: 'moderator' } }),
          user('user_d', {
            publicMetadata: { role: 'admin' },
            emailAddresses: [],
          }),
        ],
      });
      const result = await build().holdersOf('admin');
      expect(result).toEqual({
        complete: true,
        holders: [
          {
            userId: 'user_a',
            email: 'user_a@example.org',
            name: 'Synthetic Admin',
          },
          { userId: 'user_b', name: 'second' },
          { userId: 'user_d' },
        ],
      });
      expect(getUserList).toHaveBeenNthCalledWith(2, {
        limit: CLERK_PAGE,
        offset: CLERK_PAGE,
        orderBy: '+created_at',
      });
    });

    it('says the list is incomplete past the page limit', async () => {
      getUserList.mockResolvedValue({
        data: Array.from({ length: CLERK_PAGE }, (_, i) => user(`user_${i}`)),
      });
      await expect(build().holdersOf('admin')).resolves.toEqual({
        holders: [],
        complete: false,
      });
      expect(getUserList).toHaveBeenCalledTimes(MAX_USER_PAGES);
    });

    it('reports an unreachable Clerk as unavailable, never its raw text', async () => {
      getUserList.mockRejectedValue(new Error('raw clerk text'));
      await expect(build().holdersOf('admin')).rejects.toThrow(
        new ServiceUnavailableException(CLERK_UNAVAILABLE),
      );
    });
  });

  describe('invitations', () => {
    it('invites with the role, or with none for a member', async () => {
      createInvitation.mockResolvedValue({
        id: 'inv_1',
        emailAddress: 'new@example.org',
        publicMetadata: { role: 'admin' },
        createdAt: CREATED,
      });
      const service = build();
      await expect(
        service.invite('new@example.org', 'admin', 'https://x.test/community'),
      ).resolves.toEqual({
        invitationId: 'inv_1',
        email: 'new@example.org',
        role: 'admin',
        createdAt: new Date(CREATED).toISOString(),
      });
      expect(createInvitation).toHaveBeenCalledWith({
        emailAddress: 'new@example.org',
        redirectUrl: 'https://x.test/community',
        notify: true,
        publicMetadata: { role: 'admin' },
      });
      createInvitation.mockResolvedValue({
        id: 'inv_2',
        emailAddress: 'm@example.org',
        publicMetadata: null,
        createdAt: CREATED,
      });
      await expect(
        service.invite('m@example.org', null, 'https://x.test/community'),
      ).resolves.not.toHaveProperty('role');
      expect(createInvitation).toHaveBeenLastCalledWith({
        emailAddress: 'm@example.org',
        redirectUrl: 'https://x.test/community',
        notify: true,
      });
    });

    it('lists the waiting invitations', async () => {
      getInvitationList.mockResolvedValue({
        data: [
          {
            id: 'inv_1',
            emailAddress: 'a@example.org',
            publicMetadata: {},
            createdAt: CREATED,
          },
        ],
      });
      await expect(build().pendingInvitations()).resolves.toEqual({
        complete: true,
        invitations: [
          {
            invitationId: 'inv_1',
            email: 'a@example.org',
            createdAt: new Date(CREATED).toISOString(),
          },
        ],
      });
      expect(getInvitationList).toHaveBeenCalledWith({
        status: 'pending',
        orderBy: '-created_at',
        limit: CLERK_PAGE,
        offset: 0,
      });
    });

    it('pages through the waiting invitations, and says when it stopped short (LOW-1)', async () => {
      const full = Array.from({ length: CLERK_PAGE }, (_, i) => ({
        id: `inv_${i}`,
        emailAddress: `${i}@example.org`,
        publicMetadata: null,
        createdAt: CREATED,
      }));
      getInvitationList
        .mockResolvedValueOnce({ data: full })
        .mockResolvedValueOnce({ data: full.slice(0, 2) });
      const two = await build().pendingInvitations();
      expect(two.complete).toBe(true);
      expect(two.invitations).toHaveLength(CLERK_PAGE + 2);
      expect(getInvitationList).toHaveBeenLastCalledWith(
        expect.objectContaining({ offset: CLERK_PAGE }),
      );
      getInvitationList.mockReset().mockResolvedValue({ data: full });
      const capped = await build().pendingInvitations();
      expect(capped.complete).toBe(false);
      expect(getInvitationList).toHaveBeenCalledTimes(MAX_INVITATION_PAGES);
    });

    it('passes an expiry only when one is given (MEDIUM-3)', async () => {
      createInvitation.mockResolvedValue({
        id: 'inv_1',
        emailAddress: 'a@example.org',
        publicMetadata: { role: 'admin' },
        createdAt: CREATED,
      });
      await build().invite('a@example.org', 'admin', 'https://x.test', 3);
      expect(createInvitation).toHaveBeenCalledWith(
        expect.objectContaining({ expiresInDays: 3 }),
      );
    });

    it('revokes one, and says when it is not waiting', async () => {
      revokeInvitation.mockResolvedValue({});
      const service = build();
      await expect(service.revoke('inv_1')).resolves.toBeUndefined();
      expect(revokeInvitation).toHaveBeenCalledWith('inv_1');
      revokeInvitation.mockRejectedValue({ status: 400 });
      await expect(service.revoke('inv_1')).rejects.toThrow(
        new NotFoundException(INVITATION_NOT_FOUND),
      );
    });
  });
});

describe('usersByEmail (MEDIUM-2)', () => {
  beforeEach(() => getUserList.mockReset());

  it('reads the accounts with those addresses, with role and verification', async () => {
    getUserList.mockResolvedValue({
      data: [
        user('user_a', {
          publicMetadata: { role: 'admin' },
          emailAddresses: [
            {
              id: 'e1',
              emailAddress: 'A@example.org',
              verification: { status: 'verified' },
            },
          ],
        }),
        user('user_b', {
          emailAddresses: [
            { id: 'e1', emailAddress: 'b@example.org', verification: null },
          ],
        }),
      ],
    });
    await expect(
      build().usersByEmail(['a@example.org', 'b@example.org']),
    ).resolves.toEqual([
      {
        holder: { userId: 'user_a', email: 'a@example.org' },
        role: 'admin',
        emailVerified: true,
      },
      {
        holder: { userId: 'user_b', email: 'b@example.org' },
        emailVerified: false,
      },
    ]);
    expect(getUserList).toHaveBeenCalledWith({
      emailAddress: ['a@example.org', 'b@example.org'],
      limit: CLERK_PAGE,
    });
  });

  it('asks a hundred addresses at a time, all of them (round 2, LOW 3)', async () => {
    getUserList
      .mockResolvedValueOnce({ data: [user('user_a')] })
      .mockResolvedValueOnce({ data: [user('user_b')] });
    const emails = Array.from(
      { length: CLERK_PAGE + 1 },
      (_, i) => `${i}@example.org`,
    );
    const found = await build().usersByEmail(emails);
    expect(found.map((f) => f.holder.userId)).toEqual(['user_a', 'user_b']);
    expect(getUserList).toHaveBeenNthCalledWith(2, {
      emailAddress: [`${CLERK_PAGE}@example.org`],
      limit: CLERK_PAGE,
    });
  });

  it('stops waiting for a Clerk call that hangs', async () => {
    jest.useFakeTimers();
    getUserList.mockReturnValue(new Promise(() => undefined));
    const result = build()
      .usersByEmail(['a@example.org'])
      .catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(CLERK_TIMEOUT_MS + 1);
    // A read: nothing changed, so a plain 503, not an unknown outcome.
    expect(await result).toEqual(
      new ServiceUnavailableException(CLERK_READ_UNAVAILABLE),
    );
    expect(await result).not.toBeInstanceOf(ClerkOutcomeUnknown);
    jest.useRealTimers();
  });

  it('asks nothing for an empty list', async () => {
    await expect(build().usersByEmail([])).resolves.toEqual([]);
    expect(getUserList).not.toHaveBeenCalled();
  });
});

describe('translate', () => {
  it('a write Clerk definitely refused for another reason changed nothing (round 4)', () => {
    for (const mode of ['invite', 'revoke'] as const) {
      const refused = translate({ status: 403, errors: [] }, mode);
      expect(refused.message).toBe(CLERK_WRITE_REFUSED_HERE);
      expect(refused).not.toBeInstanceOf(ClerkOutcomeUnknown);
    }
    for (const mode of ['invite', 'revoke'] as const) {
      expect(translate({ status: 502, errors: [] }, mode)).toBeInstanceOf(
        ClerkOutcomeUnknown,
      );
      expect(translate(new TypeError('boom'), mode)).toBeInstanceOf(
        ClerkOutcomeUnknown,
      );
    }
    const unknown = new ClerkOutcomeUnknown();
    expect(translate(unknown, 'invite')).toBe(unknown);
    // A read keeps a plain 503 as it is.
    const read = new ServiceUnavailableException('read');
    expect(translate(read, 'read')).toBe(read);
  });

  it.each([
    [{ status: 404 }, 'revoke', NotFoundException],
    [{ status: 422 }, 'revoke', NotFoundException],
    [{ status: 500 }, 'revoke', ServiceUnavailableException],
    [
      { status: 422, errors: [{ code: 'duplicate_record' }] },
      'invite',
      ConflictException,
    ],
    [
      { status: 400, errors: [{ code: 'form_identifier_exists' }] },
      'invite',
      ConflictException,
    ],
    [
      { status: 422, errors: [{ code: 'form_param_format_invalid' }] },
      'invite',
      BadRequestException,
    ],
    [{ status: 400 }, 'invite', BadRequestException],
    [{ status: 404 }, 'invite', BadRequestException],
    [{ status: 503 }, 'invite', ServiceUnavailableException],
    [{ status: 422 }, 'read', ServiceUnavailableException],
    [null, 'read', ServiceUnavailableException],
    ['text', 'invite', ServiceUnavailableException],
  ] as const)('%o (%s) → %p', (error, mode, kind) => {
    expect(translate(error, mode)).toBeInstanceOf(kind);
  });

  it('words each one for the admin', () => {
    expect(
      translate({ status: 422, errors: [{ code: 'duplicate' }] }, 'invite')
        .message,
    ).toBe(ALREADY_INVITED);
    expect(translate({ status: 422 }, 'invite').message).toBe(
      INVITATION_REFUSED,
    );
  });
});
