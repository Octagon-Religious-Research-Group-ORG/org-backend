// Review round 3: a slow Clerk, through the REAL stack. Only Clerk's own
// client is faked; ClerkUserInfoService, ClerkAdminDirectoryService and
// RolesService are the real ones, with their real timeouts. A write Clerk is
// still processing when everyone stops waiting must never let the role lock
// go, and must never be logged as "failed". Synthetic data only.
import { Logger } from '@nestjs/common';
import { createClerkClient } from '@clerk/backend';
import { ClerkAdminDirectoryService } from '../../auth/clerk-admin-directory.service';
import {
  CLERK_TIMEOUT_MS,
  ClerkUserInfoService,
} from '../../auth/clerk-user-info.service';
import { RolesService } from '../../auth/roles.service';
import { AdminRolesService, ROLE_LOCK_STALE_MS } from './admin-roles.service';

jest.mock('@clerk/backend', () => ({ createClerkClient: jest.fn() }));

const ADMIN = 'user_admin';
const TARGET = 'user_target';

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

function build() {
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
  jest.mocked(createClerkClient).mockReturnValue({
    users: {
      getUser: (id: string) =>
        Promise.resolve(clerkUser(id, id === TARGET ? 'admin' : 'admin')),
      getUserList: () =>
        Promise.resolve({
          data: [clerkUser(ADMIN, 'admin'), clerkUser(TARGET, 'admin')],
        }),
      updateUserMetadata: slow('WRITE'),
    },
    invitations: { createInvitation: slow('INVITE') },
  } as never);
  const config = {
    getOrThrow: (key: string) =>
      key === 'PUBLIC_APP_URL' ? 'https://org.example' : 'sk_test',
  };
  const log = {
    record: jest.fn((entry: { action: string }) => {
      events.push(entry.action);
      return Promise.resolve({});
    }),
  };
  const settingModel = {
    updateOne: jest.fn(() => {
      events.push('lock');
      return { exec: () => Promise.resolve({}) };
    }),
    deleteOne: jest.fn(() => {
      events.push('unlock');
      return { exec: () => Promise.resolve({}) };
    }),
    exists: jest.fn(() => ({ exec: () => Promise.resolve({ _id: 'l' }) })),
  };
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
        select: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
      }),
    } as never,
  );
  return { service, events, landings };
}

describe('a slow Clerk, through the real services (review round 3)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => {
    jest.useRealTimers();
    warn.mockRestore();
  });

  it('a role write that times out is logged unknown, and the lock is never released early', async () => {
    const { service, events, landings } = build();
    const result = service
      .demote(ADMIN, TARGET, 'Synthetic')
      .catch((error: unknown) => error);
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
      .catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(CLERK_TIMEOUT_MS + 1);
    expect(await result).toBeInstanceOf(Error);
    await jest.advanceTimersByTimeAsync(ROLE_LOCK_STALE_MS);
    landings.forEach((land) => land());
    await jest.advanceTimersByTimeAsync(0);
    expect(events).toEqual([
      'lock',
      'invitation.requested',
      'HTTP-INVITE-SENT',
      'invitation.unknown',
      'HTTP-INVITE-LANDED',
    ]);
  });
});
