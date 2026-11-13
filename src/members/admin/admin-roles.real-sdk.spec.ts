// Review round 6 (mutants M16-M20): definite Clerk refusals through the REAL
// stack, with the real Clerk SDK and only `fetch` stubbed. Each refusal must
// be marked `refused`, logged as failed, and release the role lock. No request
// leaves the machine (the SDK reads the global `fetch` per call under
// NODE_ENV=test). Synthetic data and key only.
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ALREADY_INVITED,
  CLERK_WRITE_REFUSED_HERE,
  ClerkAdminDirectoryService,
  INVITATION_NOT_FOUND,
  INVITATION_REFUSED,
} from '../../auth/clerk-admin-directory.service';
import { ClerkUserInfoService } from '../../auth/clerk-user-info.service';
import { RolesService } from '../../auth/roles.service';
import { settledAs } from '../../auth/write-outcome';
import { AdminRolesService } from './admin-roles.service';

const ADMIN = 'user_admin';
const KEY = 'sk_test_synthetic_key_for_tests';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const clerkError = (status: number, code: string) =>
  json(status, { errors: [{ code, message: 'synthetic' }] });
const user = (id: string) => ({
  object: 'user',
  id,
  primary_email_address_id: 'e1',
  email_addresses: [
    {
      object: 'email_address',
      id: 'e1',
      email_address: `${id}@example.org`,
      verification: { status: 'verified' },
      linked_to: [],
    },
  ],
  public_metadata: {},
});

function build(write: () => Response) {
  const events: string[] = [];
  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && /\/users\/[^/?]+$/.test(String(url))) {
      const id = String(url).split('/').pop() as string;
      return Promise.resolve(json(200, user(id)));
    }
    events.push(`HTTP-${method}`);
    return Promise.resolve(write());
  });
  globalThis.fetch = fetchMock;
  const config = {
    getOrThrow: (key: string) =>
      key === 'PUBLIC_APP_URL' ? 'https://org.example' : KEY,
  };
  const log = {
    record: jest.fn((entry: { action: string }) => {
      events.push(entry.action);
      return Promise.resolve({});
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
  const clerkInfo = new ClerkUserInfoService(config as never);
  const empty = {
    find: () => ({
      select: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
    }),
  };
  const service = new AdminRolesService(
    config as never,
    new ClerkAdminDirectoryService(config as never),
    clerkInfo,
    new RolesService(clerkInfo, log as never),
    log as never,
    settingModel as never,
    empty as never,
    {
      isAdminNow: () => Promise.resolve(true),
      allowlist: () => [],
      isAllowlisted: () => false,
      forgetRole: () => Promise.resolve(),
    } as never,
    empty as never,
  );
  return { service, events };
}

describe('definite Clerk refusals through the real SDK (review round 6)', () => {
  const realFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it.each([
    [
      'a 422 (refused)',
      () => clerkError(422, 'form_param_format_invalid'),
      BadRequestException,
      INVITATION_REFUSED,
    ],
    [
      'a duplicate',
      () => clerkError(422, 'duplicate_record'),
      ConflictException,
      ALREADY_INVITED,
    ],
    [
      'a 409 (another refusal)',
      () => clerkError(409, 'conflict'),
      ServiceUnavailableException,
      CLERK_WRITE_REFUSED_HERE,
    ],
    [
      'a 404',
      () => clerkError(404, 'resource_not_found'),
      BadRequestException,
      INVITATION_REFUSED,
    ],
  ])(
    'an invitation Clerk refused with %s is failed, marked refused, and frees the lock',
    async (_label, write, kind, message) => {
      const { service, events } = build(write);
      const error = await service
        .invite(ADMIN, 'x@example.org', 'admin', undefined)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(kind);
      expect((error as Error).message).toBe(message);
      expect(settledAs(error)).toBe('refused');
      expect(events).toEqual([
        'lock',
        'invitation.requested',
        'HTTP-POST',
        'invitation.failed',
        'unlock',
      ]);
    },
  );

  it.each([
    ['a 404', () => clerkError(404, 'resource_not_found'), NotFoundException],
    ['a 422', () => clerkError(422, 'invalid'), NotFoundException],
    ['a 400', () => clerkError(400, 'bad'), NotFoundException],
    ['a 409', () => clerkError(409, 'conflict'), ServiceUnavailableException],
  ])(
    'a withdrawal Clerk refused with %s is failed, marked refused, and frees the lock',
    async (_label, write, kind) => {
      const { service, events } = build(write);
      const error = await service
        .revokeInvitation(ADMIN, 'inv_1')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(kind);
      if (kind === NotFoundException) {
        expect((error as Error).message).toBe(INVITATION_NOT_FOUND);
      }
      expect(settledAs(error)).toBe('refused');
      expect(events).toEqual([
        'lock',
        'invitation.revoke.requested',
        'HTTP-POST',
        'invitation.revoke.failed',
        'unlock',
      ]);
    },
  );

  it('a role write Clerk refused as not found is failed, marked refused, and frees the lock', async () => {
    const { service, events } = build(() => clerkError(404, 'not_found'));
    const error = await service
      .promote(ADMIN, 'user_new', 'r')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect(settledAs(error)).toBe('refused');
    expect(events).toEqual([
      'lock',
      'role.change.requested',
      'HTTP-PATCH',
      'role.change.failed',
      'unlock',
    ]);
  });
});
