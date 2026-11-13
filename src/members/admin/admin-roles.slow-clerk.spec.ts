// Reviews rounds 3 and 4: Clerk WRITES with an uncertain outcome, through the
// REAL stack. Only Clerk's own client is faked; ClerkUserInfoService,
// ClerkAdminDirectoryService and RolesService are the real ones. The rule:
// unless Clerk definitely refused a write, its outcome is UNKNOWN, so the role
// lock is kept, the log says unknown, and the admin is told so. Nothing,
// not even a failing log write, may turn that back into a release or a
// "failed". Synthetic data only.
import { Logger } from '@nestjs/common';
import { createClerkClient } from '@clerk/backend';
import { ClerkAdminDirectoryService } from '../../auth/clerk-admin-directory.service';
import {
  CLERK_TIMEOUT_MS,
  ClerkUserInfoService,
} from '../../auth/clerk-user-info.service';
import { RolesService } from '../../auth/roles.service';
import {
  AdminRolesService,
  DEMOTION_UNKNOWN,
  FOLLOW_UP_UNKNOWN,
  OUTCOME_UNKNOWN,
  ROLE_LOCK_STALE_MS,
} from './admin-roles.service';

jest.mock('@clerk/backend', () => ({ createClerkClient: jest.fn() }));

const ADMIN = 'user_admin';
const TARGET = 'user_target';

/** What the SDK throws when the connection fails or a 200's body is unreadable. */
const TRANSPORT_FAILURE = Object.assign(new Error(''), {
  status: undefined,
  errors: [{ code: 'unexpected_error', message: 'fetch failed' }],
});
/** What it throws for a 5xx with a non-JSON body. */
const SERVER_ERROR = Object.assign(new Error('Bad Gateway'), {
  status: 502,
  errors: [],
});
/** A definite refusal. */
const REFUSED = Object.assign(new Error('Unprocessable'), {
  status: 422,
  errors: [{ code: 'form_param_format_invalid' }],
});

function clerkUser(id: string, role?: string) {
  return {
    id,
    publicMetadata: role ? { role } : {},
    primaryEmailAddressId: 'e1',
    emailAddresses: [
      {
        id: 'e1',
        emailAddress: `${id}@example.org`,
        verification: { status: 'verified' },
      },
    ],
  };
}

function build(
  options: {
    /** Log writes whose action matches fail, as if Mongo were down. */
    failLog?: RegExp;
    /** Earlier admin invitations by the target, for the cleanup. */
    targetInvitations?: string[];
  } = {},
) {
  const events: string[] = [];
  const landings: Array<() => void> = [];
  /** A request Clerk receives at once and finishes only when told. */
  const slow = (name: string) => () => {
    events.push(`HTTP-${name}-SENT`);
    return new Promise<unknown>((resolve) => {
      landings.push(() => {
        events.push(`HTTP-${name}-LANDED`);
        resolve({
          id: 'inv_late',
          emailAddress: 'late@example.org',
          publicMetadata: { role: 'admin' },
          createdAt: Date.now(),
        });
      });
    });
  };
  const client = {
    users: {
      getUser: (id: string) =>
        Promise.resolve(
          clerkUser(id, id === ADMIN || id === TARGET ? 'admin' : undefined),
        ),
      getUserList: () =>
        Promise.resolve({
          data: [clerkUser(ADMIN, 'admin'), clerkUser(TARGET, 'admin')],
        }),
      updateUserMetadata: jest.fn(slow('WRITE')),
    },
    invitations: {
      createInvitation: jest.fn(slow('INVITE')),
      getInvitationList: () =>
        Promise.resolve({
          data: (options.targetInvitations ?? []).map((id) => ({
            id,
            emailAddress: `${id}@example.org`,
            publicMetadata: { role: 'admin' },
            createdAt: Date.now(),
          })),
        }),
      revokeInvitation: jest.fn(slow('REVOKE')),
    },
  };
  jest.mocked(createClerkClient).mockReturnValue(client as never);
  const config = {
    getOrThrow: (key: string) =>
      key === 'PUBLIC_APP_URL' ? 'https://org.example' : 'sk_test',
  };
  const log = {
    record: jest.fn((entry: { action: string }) => {
      events.push(entry.action);
      return options.failLog?.test(entry.action)
        ? Promise.reject(new Error('synthetic Mongo outage'))
        : Promise.resolve({});
    }),
  };
  const settingModel = {
    updateOne: jest.fn((filter: { value?: string }) => {
      events.push(filter.value === undefined ? 'lock' : 'lock-bumped');
      return { exec: () => Promise.resolve({}) };
    }),
    deleteOne: jest.fn(() => {
      events.push('unlock');
      return { exec: () => Promise.resolve({}) };
    }),
    exists: jest.fn(() => ({ exec: () => Promise.resolve({ _id: 'l' }) })),
  };
  const sentRows = (options.targetInvitations ?? []).map((id) => ({
    action: 'invitation.sent',
    at: new Date(),
    details: { invitationId: id },
  }));
  const clerkInfo = new ClerkUserInfoService(config as never);
  const service = new AdminRolesService(
    config as never,
    new ClerkAdminDirectoryService(config as never),
    clerkInfo,
    new RolesService(clerkInfo, log as never),
    log as never,
    settingModel as never,
    {
      find: () => ({
        select: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
      }),
    } as never,
    {
      isAdminNow: () => Promise.resolve(true),
      allowlist: () => [],
      isAllowlisted: () => false,
      forgetRole: () => Promise.resolve(),
    } as never,
    {
      find: () => ({
        select: () => ({
          lean: () => ({ exec: () => Promise.resolve(sentRows) }),
        }),
      }),
    } as never,
  );
  return { service, events, landings, client };
}

describe('uncertain Clerk writes, through the real services (reviews 3 and 4)', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    jest.useRealTimers();
    warn.mockRestore();
    error.mockRestore();
  });

  it('a role write that times out is logged unknown, and the lock is never released early', async () => {
    const { service, events, landings } = build();
    const result = service
      .demote(ADMIN, TARGET, 'Synthetic')
      .catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(CLERK_TIMEOUT_MS + 1);
    expect(await result).toBeInstanceOf(Error);
    // Clerk finishes the write long after everyone stopped waiting.
    await jest.advanceTimersByTimeAsync(ROLE_LOCK_STALE_MS);
    landings.forEach((land) => land());
    await jest.advanceTimersByTimeAsync(0);
    expect(events).toEqual([
      'lock',
      'role.change.requested',
      'HTTP-WRITE-SENT',
      'lock-bumped',
      'role.change.timeout',
      'HTTP-WRITE-LANDED',
    ]);
    expect(events).not.toContain('unlock');
    expect(events).not.toContain('role.change.failed');
  });

  it('an invitation that times out is logged unknown, and the lock is never released early', async () => {
    const { service, events, landings } = build();
    const result = service
      .invite(ADMIN, 'late@example.org', 'admin', undefined)
      .catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(CLERK_TIMEOUT_MS + 1);
    expect(await result).toBeInstanceOf(Error);
    await jest.advanceTimersByTimeAsync(ROLE_LOCK_STALE_MS);
    landings.forEach((land) => land());
    await jest.advanceTimersByTimeAsync(0);
    expect(events).toEqual([
      'lock',
      'invitation.requested',
      'HTTP-INVITE-SENT',
      'lock-bumped',
      'invitation.unknown',
      'HTTP-INVITE-LANDED',
    ]);
  });

  it('P2: a demotion whose answer could not be read is unknown, never failed (round 4)', async () => {
    const { service, events, client } = build();
    client.users.updateUserMetadata.mockRejectedValueOnce(TRANSPORT_FAILURE);
    await expect(service.demote(ADMIN, TARGET, 'r')).rejects.toThrow(
      DEMOTION_UNKNOWN,
    );
    expect(events).toContain('role.change.timeout');
    expect(events).not.toContain('role.change.failed');
    expect(events).not.toContain('unlock');
  });

  it('P3: an invitation answered with a 5xx is unknown, so a later cleanup can find it (round 4)', async () => {
    const { service, events, client } = build();
    client.invitations.createInvitation.mockRejectedValueOnce(SERVER_ERROR);
    await expect(
      service.invite(ADMIN, 'x@example.org', 'admin', undefined),
    ).rejects.toThrow(OUTCOME_UNKNOWN);
    expect(events).toContain('invitation.unknown');
    expect(events).not.toContain('invitation.failed');
    expect(events).not.toContain('unlock');
  });

  it('a definite refusal is failed, and frees the lock', async () => {
    const { service, events, client } = build();
    client.users.updateUserMetadata.mockRejectedValueOnce(REFUSED);
    await expect(service.demote(ADMIN, TARGET, 'r')).rejects.toBeInstanceOf(
      Error,
    );
    expect(events).toContain('role.change.failed');
    expect(events.at(-1)).toBe('unlock');
  });

  describe('a failing log write never replaces an unknown outcome (MEDIUM-1)', () => {
    it('setRole', async () => {
      const { service, events, client } = build({ failLog: /timeout/ });
      client.users.updateUserMetadata.mockRejectedValueOnce(TRANSPORT_FAILURE);
      await expect(service.promote(ADMIN, 'user_new', 'r')).rejects.toThrow(
        OUTCOME_UNKNOWN,
      );
      expect(events).toEqual([
        'lock',
        'role.change.requested',
        'lock-bumped',
        'role.change.timeout',
      ]);
    });

    it('invite', async () => {
      const { service, events, client } = build({ failLog: /unknown/ });
      client.invitations.createInvitation.mockRejectedValueOnce(
        TRANSPORT_FAILURE,
      );
      await expect(
        service.invite(ADMIN, 'x@example.org', 'admin', undefined),
      ).rejects.toThrow(OUTCOME_UNKNOWN);
      expect(events).not.toContain('unlock');
    });

    it('withdrawing an invitation', async () => {
      const { service, events, client } = build({ failLog: /unknown/ });
      client.invitations.revokeInvitation.mockRejectedValueOnce(SERVER_ERROR);
      await expect(service.revokeInvitation(ADMIN, 'inv_1')).rejects.toThrow(
        OUTCOME_UNKNOWN,
      );
      expect(events).toContain('invitation.revoke.unknown');
      expect(events).not.toContain('unlock');
    });

    it('the withdrawals after a demotion', async () => {
      const { service, events, client } = build({
        failLog: /unknown/,
        targetInvitations: ['inv_theirs', 'inv_other_theirs'],
      });
      client.users.updateUserMetadata.mockResolvedValueOnce({});
      client.invitations.revokeInvitation.mockRejectedValueOnce(
        TRANSPORT_FAILURE,
      );
      await expect(service.demote(ADMIN, TARGET, 'r')).resolves.toStrictEqual({
        role: null,
        followUpWarning: FOLLOW_UP_UNKNOWN,
      });
      expect(client.invitations.revokeInvitation).toHaveBeenCalledTimes(1);
      expect(events).toContain('invitation.revoke.unknown');
      expect(events).not.toContain('unlock');
    });
  });
});
