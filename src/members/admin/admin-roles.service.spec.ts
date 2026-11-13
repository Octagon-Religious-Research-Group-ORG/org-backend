import {
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  ADMIN_INVITATION_DAYS,
  ADMINS_UNCOUNTABLE,
  ALLOWLIST_ADMIN,
  ALREADY_ADMIN,
  AdminRolesService,
  CLERK_CALL_TIMEOUT_MS,
  CLERK_TOO_SLOW,
  emailForLog,
  LAST_ADMIN,
  NO_LONGER_ADMIN,
  NOT_A_MEMBER,
  NOT_ADMIN,
  OWN_DEMOTION,
  OWN_PROMOTION,
  ROLE_CHANGE_BUSY,
  ROLE_CHANGE_DEADLINE_MS,
  ROLE_CHANGE_LOST,
  ROLE_LOCK_KEY,
  ROLE_LOCK_STALE_MS,
  ROLE_WRITE_TIMEOUT_MS,
  within,
} from './admin-roles.service';

const ADMIN = 'user_admin';
const OTHER = 'user_other';
const MEMBER = 'user_member';
const duplicate = Object.assign(new Error('E11000'), { code: 11000 });

function chain(value: unknown) {
  const query = {
    select: () => query,
    lean: () => query,
    exec: () => Promise.resolve(value),
  };
  return query;
}

function build(
  options: {
    holders?: Array<{ userId: string; email?: string }>;
    complete?: boolean;
    identity?: Record<string, unknown>;
    actorIsAdmin?: boolean;
    allowlisted?: string[];
  } = {},
) {
  const order: string[] = [];
  const directory = {
    holdersOf: jest.fn(() =>
      Promise.resolve({
        holders: options.holders ?? [{ userId: ADMIN }, { userId: OTHER }],
        complete: options.complete ?? true,
      }),
    ),
    usersByEmail: jest.fn(() => Promise.resolve([] as unknown[])),
    invite: jest.fn((email: string, role: string | null) => {
      order.push('clerk');
      return Promise.resolve({
        invitationId: 'inv_1',
        email,
        ...(role ? { role } : {}),
        createdAt: '2026-11-13T00:00:00.000Z',
      });
    }),
    pendingInvitations: jest.fn(() =>
      Promise.resolve({ invitations: [] as unknown[], complete: true }),
    ),
    revoke: jest.fn((id: string) => {
      order.push(`revoke:${id}`);
      return Promise.resolve();
    }),
  };
  const clerk = {
    getIdentity: jest.fn(() => Promise.resolve(options.identity ?? {})),
  };
  const roles = {
    setRole: jest.fn(() => {
      order.push('setRole');
      return Promise.resolve();
    }),
  };
  const log = {
    record: jest.fn((entry: { action: string }) => {
      order.push(entry.action);
      return Promise.resolve({});
    }),
  };
  const settingModel = {
    updateOne: jest.fn(() => {
      order.push('lock');
      return { exec: () => Promise.resolve({}) };
    }),
    deleteOne: jest.fn(() => {
      order.push('unlock');
      return { exec: () => Promise.resolve({}) };
    }),
    exists: jest.fn(() => ({ exec: () => Promise.resolve({ _id: 'lock' }) })),
  };
  const profileModel = { find: jest.fn(() => chain([])) };
  const adminAccess = {
    isAdminNow: jest.fn(() => {
      order.push('actor-check');
      return Promise.resolve(options.actorIsAdmin ?? true);
    }),
    allowlist: jest.fn(() => options.allowlisted ?? []),
    isAllowlisted: jest.fn(
      (email: string | undefined, verified: boolean) =>
        verified && (options.allowlisted ?? []).includes(String(email)),
    ),
    forgetRole: jest.fn(() => {
      order.push('forget');
      return Promise.resolve();
    }),
  };
  const logModel = { find: jest.fn(() => chain([] as unknown[])) };
  const service = new AdminRolesService(
    { getOrThrow: () => 'https://org.example/' } as never,
    directory as never,
    clerk as never,
    roles as never,
    log as never,
    settingModel as never,
    profileModel as never,
    adminAccess as never,
    logModel as never,
  );
  return {
    service,
    directory,
    clerk,
    roles,
    log,
    settingModel,
    profileModel,
    adminAccess,
    logModel,
    order,
  };
}

describe('AdminRolesService', () => {
  afterEach(() => jest.useRealTimers());

  describe('admins', () => {
    it('lists the Clerk admins with their pages, and marks you', async () => {
      const { service, profileModel } = build({
        holders: [{ userId: ADMIN, email: 'a@example.org' }, { userId: OTHER }],
        complete: false,
      });
      profileModel.find.mockReturnValueOnce(
        chain([{ ownerUserId: OTHER, slug: 'other', displayName: 'Other' }]),
      );
      await expect(service.admins(ADMIN)).resolves.toEqual({
        complete: false,
        admins: [
          { userId: ADMIN, email: 'a@example.org', isYou: true },
          {
            userId: OTHER,
            page: { slug: 'other', displayName: 'Other' },
            isYou: false,
          },
        ],
      });
      expect(profileModel.find).toHaveBeenCalledWith({
        ownerUserId: { $in: [ADMIN, OTHER] },
        reviewStatus: { $ne: 'claiming' },
        deletedAt: { $exists: false },
      });
    });

    it('adds the allowlist-only admins, marked, and nobody else (MEDIUM-2)', async () => {
      const { service, directory } = build({
        holders: [{ userId: ADMIN, email: 'a@example.org' }],
        allowlisted: [
          'a@example.org',
          'list@example.org',
          'unverified@example.org',
          'role@example.org',
        ],
      });
      directory.usersByEmail.mockResolvedValueOnce([
        // Already a Clerk admin: listed once.
        {
          holder: { userId: ADMIN, email: 'a@example.org' },
          role: 'admin',
          emailVerified: true,
        },
        {
          holder: { userId: 'user_list', email: 'list@example.org' },
          emailVerified: true,
        },
        {
          holder: { userId: 'user_unv', email: 'unverified@example.org' },
          emailVerified: false,
        },
        // Clerk lists the role, but holdersOf did not see it yet.
        {
          holder: { userId: 'user_role', email: 'role@example.org' },
          role: 'admin',
          emailVerified: true,
        },
        { holder: { userId: 'user_noemail' }, emailVerified: true },
        {
          holder: { userId: 'user_other_addr', email: 'other@example.org' },
          emailVerified: true,
        },
      ]);
      const { admins } = await service.admins(ADMIN);
      expect(directory.usersByEmail).toHaveBeenCalledWith([
        'a@example.org',
        'list@example.org',
        'unverified@example.org',
        'role@example.org',
      ]);
      expect(admins).toEqual([
        { userId: ADMIN, email: 'a@example.org', isYou: true },
        {
          userId: 'user_list',
          email: 'list@example.org',
          isYou: false,
          viaAllowlist: true,
        },
      ]);
    });
  });

  describe('promote', () => {
    it('checks the actor in Clerk under the lock, then changes the role, then frees it', async () => {
      const { service, roles, settingModel, adminAccess, order } = build();
      await expect(
        service.promote(ADMIN, MEMBER, 'Synthetic reason'),
      ).resolves.toEqual({ role: 'admin' });
      expect(adminAccess.isAdminNow).toHaveBeenCalledWith(ADMIN);
      expect(roles.setRole).toHaveBeenCalledWith({
        actorUserId: ADMIN,
        targetUserId: MEMBER,
        role: 'admin',
        reason: 'Synthetic reason',
      });
      expect(order).toEqual(['lock', 'actor-check', 'setRole', 'unlock']);
      const [filter, update, options] = settingModel.updateOne.mock
        .calls[0] as unknown as [
        { key: string; updatedAt: { $lt: Date } },
        { $set: { value: string; updatedBy: string } },
        unknown,
      ];
      expect(filter.key).toBe(ROLE_LOCK_KEY);
      expect(
        Date.now() - filter.updatedAt.$lt.getTime(),
      ).toBeGreaterThanOrEqual(ROLE_LOCK_STALE_MS);
      expect(update.$set.updatedBy).toBe(ADMIN);
      expect(options).toEqual({ upsert: true });
      // The fence and the release both name this change's own token.
      expect(settingModel.exists).toHaveBeenCalledWith({
        key: ROLE_LOCK_KEY,
        value: update.$set.value,
      });
      expect(settingModel.deleteOne).toHaveBeenCalledWith({
        key: ROLE_LOCK_KEY,
        value: update.$set.value,
      });
    });

    it('never lets anyone change their own role, before the lock (HIGH-1)', async () => {
      const { service, settingModel, roles } = build();
      await expect(service.promote(ADMIN, ADMIN, 'r')).rejects.toThrow(
        new ForbiddenException(OWN_PROMOTION),
      );
      expect(settingModel.updateOne).not.toHaveBeenCalled();
      expect(roles.setRole).not.toHaveBeenCalled();
    });

    it('refuses an actor still cached as admin but no longer one in Clerk (HIGH-1)', async () => {
      const { service, roles, clerk, order } = build({ actorIsAdmin: false });
      await expect(service.promote(ADMIN, MEMBER, 'r')).rejects.toThrow(
        new ForbiddenException(NO_LONGER_ADMIN),
      );
      expect(clerk.getIdentity).not.toHaveBeenCalled();
      expect(roles.setRole).not.toHaveBeenCalled();
      expect(order).toEqual(['lock', 'actor-check', 'unlock']);
    });

    it('treats an actor Clerk no longer knows as not an admin', async () => {
      const { service, adminAccess } = build();
      adminAccess.isAdminNow.mockRejectedValueOnce(new UnauthorizedException());
      await expect(service.promote(ADMIN, MEMBER, 'r')).rejects.toThrow(
        new ForbiddenException(NO_LONGER_ADMIN),
      );
      adminAccess.isAdminNow.mockRejectedValueOnce(
        new ServiceUnavailableException('down'),
      );
      await expect(service.promote(ADMIN, MEMBER, 'r')).rejects.toThrow('down');
    });

    it('refuses someone already an admin, and still frees the lock', async () => {
      const { service, roles, order } = build({ identity: { role: 'admin' } });
      await expect(service.promote(ADMIN, OTHER, 'r')).rejects.toThrow(
        new ConflictException(ALREADY_ADMIN),
      );
      expect(roles.setRole).not.toHaveBeenCalled();
      expect(order.at(-1)).toBe('unlock');
    });

    it('answers an unknown account with 404, and passes other failures on', async () => {
      const { service, clerk } = build();
      clerk.getIdentity.mockRejectedValueOnce(new UnauthorizedException());
      await expect(service.promote(ADMIN, MEMBER, 'r')).rejects.toThrow(
        new NotFoundException(NOT_A_MEMBER),
      );
      clerk.getIdentity.mockRejectedValueOnce(
        new ServiceUnavailableException(),
      );
      await expect(service.promote(ADMIN, MEMBER, 'r')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('says another change is under way while the lock is held', async () => {
      const { service, settingModel, roles } = build();
      settingModel.updateOne.mockReturnValueOnce({
        exec: () => Promise.reject(duplicate),
      });
      await expect(service.promote(ADMIN, MEMBER, 'r')).rejects.toThrow(
        new ConflictException(ROLE_CHANGE_BUSY),
      );
      settingModel.updateOne.mockReturnValueOnce({
        exec: () => Promise.reject(new Error('synthetic')),
      });
      await expect(service.promote(ADMIN, MEMBER, 'r')).rejects.toThrow(
        'synthetic',
      );
      expect(roles.setRole).not.toHaveBeenCalled();
      expect(settingModel.deleteOne).not.toHaveBeenCalled();
    });

    it('writes nothing once its lock was taken over (MEDIUM-1 fence)', async () => {
      const { service, settingModel, roles } = build();
      settingModel.exists.mockReturnValueOnce({
        exec: () => Promise.resolve(null),
      } as never);
      await expect(service.promote(ADMIN, MEMBER, 'r')).rejects.toThrow(
        new ServiceUnavailableException(ROLE_CHANGE_LOST),
      );
      expect(roles.setRole).not.toHaveBeenCalled();
    });

    it('writes nothing once its deadline has passed, even holding the lock', async () => {
      const { service, roles, clerk } = build();
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now');
      clerk.getIdentity.mockImplementationOnce(() => {
        clock.mockReturnValue(now + ROLE_CHANGE_DEADLINE_MS + 1);
        return Promise.resolve({});
      });
      await expect(service.promote(ADMIN, MEMBER, 'r')).rejects.toThrow(
        ROLE_CHANGE_LOST,
      );
      clock.mockRestore();
      expect(roles.setRole).not.toHaveBeenCalled();
    });

    it('gives up on a Clerk read that does not answer', async () => {
      jest.useFakeTimers();
      const { service, clerk, roles } = build();
      clerk.getIdentity.mockReturnValueOnce(new Promise(() => undefined));
      const result = service.promote(ADMIN, MEMBER, 'r');
      const caught = result.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(CLERK_CALL_TIMEOUT_MS + 1);
      expect(await caught).toEqual(
        new ServiceUnavailableException(CLERK_TOO_SLOW),
      );
      expect(roles.setRole).not.toHaveBeenCalled();
    });

    it('logs an unknown outcome when the role write does not answer', async () => {
      jest.useFakeTimers();
      const { service, roles, log } = build();
      roles.setRole.mockReturnValueOnce(new Promise(() => undefined));
      const caught = service
        .promote(ADMIN, MEMBER, 'r')
        .catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(ROLE_WRITE_TIMEOUT_MS + 1);
      expect(await caught).toEqual(
        new ServiceUnavailableException(CLERK_TOO_SLOW),
      );
      expect(log.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'role.change.timeout',
          targetId: MEMBER,
          details: { to: 'admin' },
        }),
      );
    });

    it('never lets a failed release replace the result (LOW-5)', async () => {
      const { service, settingModel } = build();
      const errorLog = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      settingModel.deleteOne.mockReturnValueOnce({
        exec: () => Promise.reject(new Error('release failed')),
      });
      await expect(service.promote(ADMIN, MEMBER, 'r')).resolves.toEqual({
        role: 'admin',
      });
      settingModel.deleteOne.mockReturnValueOnce({
        // The driver can reject with anything; the release must survive it.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        exec: () => Promise.reject('raw'),
      });
      await expect(service.promote(ADMIN, ADMIN + '_x', 'r')).resolves.toEqual({
        role: 'admin',
      });
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('release failed'),
      );
      errorLog.mockRestore();
    });
  });

  describe('demote', () => {
    it('removes another admin’s role, clears their cache, when another admin remains', async () => {
      const { service, roles, adminAccess, order } = build({
        identity: { role: 'admin' },
      });
      await expect(
        service.demote(ADMIN, OTHER, 'Stepping back'),
      ).resolves.toEqual({ role: null });
      expect(roles.setRole).toHaveBeenCalledWith({
        actorUserId: ADMIN,
        targetUserId: OTHER,
        role: null,
        reason: 'Stepping back',
      });
      expect(adminAccess.forgetRole).toHaveBeenCalledWith(OTHER);
      expect(order).toEqual([
        'lock',
        'actor-check',
        'setRole',
        'forget',
        'unlock',
      ]);
    });

    it('never removes your own role, before taking the lock', async () => {
      const { service, settingModel } = build({ identity: { role: 'admin' } });
      await expect(service.demote(ADMIN, ADMIN, 'r')).rejects.toThrow(
        new ForbiddenException(OWN_DEMOTION),
      );
      expect(settingModel.updateOne).not.toHaveBeenCalled();
    });

    it('refuses an actor no longer an admin in Clerk', async () => {
      const { service, roles } = build({
        identity: { role: 'admin' },
        actorIsAdmin: false,
      });
      await expect(service.demote(ADMIN, OTHER, 'r')).rejects.toThrow(
        new ForbiddenException(NO_LONGER_ADMIN),
      );
      expect(roles.setRole).not.toHaveBeenCalled();
    });

    it('never removes the last admin', async () => {
      const { service, roles } = build({
        identity: { role: 'admin' },
        holders: [{ userId: OTHER }],
      });
      await expect(service.demote(ADMIN, OTHER, 'r')).rejects.toThrow(
        new ConflictException(LAST_ADMIN),
      );
      expect(roles.setRole).not.toHaveBeenCalled();
    });

    it('refuses when the admins cannot all be counted', async () => {
      const { service, roles } = build({
        identity: { role: 'admin' },
        complete: false,
      });
      await expect(service.demote(ADMIN, OTHER, 'r')).rejects.toThrow(
        new ServiceUnavailableException(ADMINS_UNCOUNTABLE),
      );
      expect(roles.setRole).not.toHaveBeenCalled();
    });

    it('refuses someone who is not an admin', async () => {
      const { service, directory } = build();
      await expect(service.demote(ADMIN, MEMBER, 'r')).rejects.toThrow(
        new ConflictException(NOT_ADMIN),
      );
      expect(directory.holdersOf).not.toHaveBeenCalled();
    });

    it('refuses an admin who would stay one through the allowlist (MEDIUM-2)', async () => {
      for (const role of ['admin', undefined]) {
        const { service, roles } = build({
          identity: { role, email: 'list@example.org', emailVerified: true },
          allowlisted: ['list@example.org'],
        });
        await expect(service.demote(ADMIN, OTHER, 'r')).rejects.toThrow(
          new ConflictException(ALLOWLIST_ADMIN),
        );
        expect(roles.setRole).not.toHaveBeenCalled();
      }
    });

    it('writes nothing once its lock was taken over', async () => {
      const { service, settingModel, roles } = build({
        identity: { role: 'admin' },
      });
      settingModel.exists.mockReturnValueOnce({
        exec: () => Promise.resolve(null),
      } as never);
      await expect(service.demote(ADMIN, OTHER, 'r')).rejects.toThrow(
        ROLE_CHANGE_LOST,
      );
      expect(roles.setRole).not.toHaveBeenCalled();
    });

    it('frees the lock when the role change fails', async () => {
      const { service, roles, order, adminAccess } = build({
        identity: { role: 'admin' },
      });
      roles.setRole.mockRejectedValueOnce(new Error('synthetic Clerk outage'));
      await expect(service.demote(ADMIN, OTHER, 'r')).rejects.toThrow(
        'synthetic Clerk outage',
      );
      expect(order.at(-1)).toBe('unlock');
      expect(adminAccess.forgetRole).not.toHaveBeenCalled();
    });

    it('withdraws the waiting admin invitations the demoted admin sent (MEDIUM-3)', async () => {
      const { service, logModel, directory, log, order } = build({
        identity: { role: 'admin' },
      });
      logModel.find.mockReturnValueOnce(
        chain([
          { details: { invitationId: 'inv_theirs' } },
          { details: { invitationId: 'inv_accepted' } },
        ]),
      );
      directory.pendingInvitations.mockResolvedValueOnce({
        invitations: [
          { invitationId: 'inv_theirs' },
          { invitationId: 'inv_someone_else' },
        ],
        complete: true,
      });
      await service.demote(ADMIN, OTHER, 'r');
      expect(logModel.find).toHaveBeenCalledWith({
        action: 'invitation.sent',
        actorUserId: OTHER,
        'details.as': 'admin',
      });
      expect(directory.revoke).toHaveBeenCalledTimes(1);
      expect(directory.revoke).toHaveBeenCalledWith('inv_theirs');
      expect(log.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'invitation.revoke.applied',
          targetId: 'inv_theirs',
          reason: 'The admin who sent this invitation is no longer an admin.',
        }),
      );
      expect(order.indexOf('revoke:inv_theirs')).toBeGreaterThan(
        order.indexOf('setRole'),
      );
    });

    it('never fails a done demotion over the follow-ups, and says so', async () => {
      const errorLog = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const { service, adminAccess, logModel, directory } = build({
        identity: { role: 'admin' },
      });
      adminAccess.forgetRole.mockRejectedValueOnce(new Error('cache'));
      logModel.find.mockReturnValueOnce(chain([{ details: {} }]));
      directory.pendingInvitations.mockRejectedValueOnce(new Error('list'));
      await expect(service.demote(ADMIN, OTHER, 'r')).resolves.toEqual({
        role: null,
      });
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('cache'));
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('list'));
      // A single revoke failing does not stop the others.
      const second = build({ identity: { role: 'admin' } });
      second.logModel.find.mockReturnValueOnce(
        chain([
          { details: { invitationId: 'inv_a' } },
          { details: { invitationId: 'inv_b' } },
        ]),
      );
      second.directory.pendingInvitations.mockResolvedValueOnce({
        invitations: [{ invitationId: 'inv_a' }, { invitationId: 'inv_b' }],
        complete: true,
      });
      second.directory.revoke.mockRejectedValueOnce(new Error('gone'));
      await second.service.demote(ADMIN, OTHER, 'r');
      expect(second.directory.revoke).toHaveBeenCalledTimes(2);
      errorLog.mockRestore();
    });
  });

  describe('invitations', () => {
    it('lists the waiting ones', async () => {
      const { service, directory } = build();
      await expect(service.invitations()).resolves.toEqual({
        invitations: [],
        complete: true,
      });
      expect(directory.pendingInvitations).toHaveBeenCalled();
    });

    it('checks the actor, logs no readable address, and sends a short-lived admin invitation', async () => {
      const { service, directory, log, order } = build();
      await service.invite(ADMIN, ' New@Example.ORG ', 'admin', undefined);
      expect(directory.invite).toHaveBeenCalledWith(
        'new@example.org',
        'admin',
        'https://org.example/community',
        ADMIN_INVITATION_DAYS,
      );
      expect(order).toEqual([
        'lock',
        'actor-check',
        'invitation.requested',
        'clerk',
        'invitation.sent',
        'unlock',
      ]);
      const hash = createHash('sha256').update('new@example.org').digest('hex');
      expect(log.record).toHaveBeenNthCalledWith(1, {
        actorUserId: ADMIN,
        targetType: 'invitation',
        targetId: `email-sha256:${hash.slice(0, 32)}`,
        reason: 'Admin invited a new admin.',
        action: 'invitation.requested',
        details: { as: 'admin', emailHash: hash, emailDomain: 'example.org' },
      });
      expect(log.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'invitation.sent',
          details: {
            as: 'admin',
            emailHash: hash,
            emailDomain: 'example.org',
            invitationId: 'inv_1',
            invitedBy: ADMIN,
            expiresInDays: ADMIN_INVITATION_DAYS,
          },
        }),
      );
      expect(JSON.stringify(log.record.mock.calls)).not.toContain(
        'new@example.org',
      );
    });

    it('refuses an actor still cached as admin but no longer one, before logging or sending (HIGH-1)', async () => {
      const { service, directory, log } = build({ actorIsAdmin: false });
      await expect(
        service.invite(ADMIN, 'a@example.org', 'admin', undefined),
      ).rejects.toThrow(new ForbiddenException(NO_LONGER_ADMIN));
      expect(directory.invite).not.toHaveBeenCalled();
      expect(log.record).not.toHaveBeenCalled();
    });

    it('invites a member with Clerk’s own expiry, keeping the reason given', async () => {
      const { service, directory, log } = build();
      await service.invite(
        ADMIN,
        'm@example.org',
        'member',
        ' Met at\u0007 a meeting ',
      );
      expect(directory.invite).toHaveBeenCalledWith(
        'm@example.org',
        null,
        'https://org.example/community',
        undefined,
      );
      expect(log.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'Met at a meeting' }),
      );
      expect(log.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          details: expect.not.objectContaining({
            expiresInDays: expect.anything() as unknown,
          }) as unknown,
        }),
      );
      await service.invite(ADMIN, 'n@example.org', 'member', '   ');
      expect(log.record).toHaveBeenLastCalledWith(
        expect.objectContaining({ reason: 'Admin invited a new member.' }),
      );
    });

    it('logs a failed or lost invitation and passes the refusal on', async () => {
      const { service, directory, log, settingModel } = build();
      directory.invite.mockRejectedValueOnce(new ConflictException('dup'));
      await expect(
        service.invite(ADMIN, 'a@example.org', 'member', undefined),
      ).rejects.toThrow(ConflictException);
      expect(log.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'invitation.failed',
          details: expect.objectContaining({ error: 'dup' }) as unknown,
        }),
      );
      directory.invite.mockRejectedValueOnce('raw');
      await expect(
        service.invite(ADMIN, 'a@example.org', 'member', undefined),
      ).rejects.toBe('raw');
      settingModel.exists.mockReturnValueOnce({
        exec: () => Promise.resolve(null),
      } as never);
      directory.invite.mockClear();
      await expect(
        service.invite(ADMIN, 'a@example.org', 'admin', undefined),
      ).rejects.toThrow(ROLE_CHANGE_LOST);
      expect(directory.invite).not.toHaveBeenCalled();
    });

    it('revokes with the same before-and-after trail, under the lock', async () => {
      const { service, directory, order, log } = build();
      await expect(service.revokeInvitation(ADMIN, 'inv_1')).resolves.toEqual({
        revoked: true,
      });
      expect(order).toEqual([
        'lock',
        'actor-check',
        'invitation.revoke.requested',
        'revoke:inv_1',
        'invitation.revoke.applied',
        'unlock',
      ]);
      directory.revoke.mockRejectedValueOnce(new NotFoundException('gone'));
      await expect(service.revokeInvitation(ADMIN, 'inv_1')).rejects.toThrow(
        NotFoundException,
      );
      expect(log.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'invitation.revoke.failed',
          details: { error: 'gone' },
        }),
      );
    });

    it('refuses a revoke by an actor no longer an admin', async () => {
      const { service, directory } = build({ actorIsAdmin: false });
      await expect(service.revokeInvitation(ADMIN, 'inv_1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(directory.revoke).not.toHaveBeenCalled();
    });
  });

  describe('helpers', () => {
    it('within passes the result, the failure, and clears its timer', async () => {
      jest.useFakeTimers();
      await expect(within(Promise.resolve(1), 10)).resolves.toBe(1);
      await expect(within(Promise.reject(new Error('x')), 10)).rejects.toThrow(
        'x',
      );
      expect(jest.getTimerCount()).toBe(0);
    });

    it('keeps the stale window far longer than one change can take', () => {
      expect(ROLE_LOCK_STALE_MS).toBeGreaterThanOrEqual(
        2 * ROLE_CHANGE_DEADLINE_MS,
      );
      expect(emailForLog('a.b@sub.example.org').emailDomain).toBe(
        'sub.example.org',
      );
    });
  });
});
