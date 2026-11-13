import {
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ClerkTimedOut } from '../../auth/clerk-user-info.service';
import {
  ADMIN_INVITATION_DAYS,
  ADMINS_UNCOUNTABLE,
  ALLOWLIST_ADMIN,
  ALREADY_ADMIN,
  AdminRolesService,
  DEMOTION_UNKNOWN,
  emailForLog,
  invitationLeads,
  isTheirs,
  FOLLOW_UP_WARNING,
  INVITATION_MATCH_SLACK_MS,
  LAST_ADMIN,
  NO_LONGER_ADMIN,
  OUTCOME_UNKNOWN,
  NOT_A_MEMBER,
  NOT_ADMIN,
  OWN_DEMOTION,
  OWN_PROMOTION,
  ROLE_CHANGE_BUSY,
  ROLE_CHANGE_DEADLINE_MS,
  ROLE_CHANGE_LOST,
  ROLE_LOCK_KEY,
  ROLE_LOCK_STALE_MS,
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
  it('words the follow-up warning for the admin', () => {
    expect(FOLLOW_UP_WARNING).toContain(
      'could not all be checked or withdrawn',
    );
  });

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
        // A Clerk admin also on the allowlist: the dashboard cannot remove
        // them (round 2, LOW 3).
        {
          userId: ADMIN,
          email: 'a@example.org',
          isYou: true,
          allowlisted: true,
        },
        {
          userId: 'user_list',
          email: 'list@example.org',
          isYou: false,
          viaAllowlist: true,
        },
      ]);
    });

    it('still lists the Clerk admins when the allowlist cannot be read (round 2, LOW 3)', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const { service, directory } = build({ allowlisted: ['a@example.org'] });
      directory.usersByEmail.mockRejectedValueOnce(new Error('clerk down'));
      await expect(service.admins(ADMIN)).resolves.toEqual({
        admins: [
          { userId: ADMIN, isYou: true },
          { userId: OTHER, isYou: false },
        ],
        complete: true,
        allowlistUnknown: true,
      });
      directory.usersByEmail.mockRejectedValueOnce('raw');
      await service.admins(ADMIN);
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
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

    it('keeps the lock after a role write with an unknown outcome (round 3)', async () => {
      const { service, roles, settingModel, order } = build();
      roles.setRole.mockRejectedValueOnce(new ClerkTimedOut());
      await expect(service.promote(ADMIN, MEMBER, 'r')).rejects.toThrow(
        new ServiceUnavailableException(OUTCOME_UNKNOWN),
      );
      expect(order).toEqual(['lock', 'actor-check']);
      expect(settingModel.deleteOne).not.toHaveBeenCalled();
    });

    it('passes a plain write failure on and frees the lock', async () => {
      const { service, roles, settingModel } = build();
      roles.setRole.mockRejectedValueOnce(new Error('refused'));
      await expect(service.promote(ADMIN, MEMBER, 'r')).rejects.toThrow(
        'refused',
      );
      expect(settingModel.deleteOne).toHaveBeenCalledTimes(1);
    });

    it('treats a timed-out read as a plain 503, and frees the lock (nothing was written)', async () => {
      const { service, clerk, settingModel, roles } = build();
      clerk.getIdentity.mockRejectedValueOnce(new ClerkTimedOut());
      await expect(service.promote(ADMIN, MEMBER, 'r')).rejects.toThrow(
        ClerkTimedOut,
      );
      expect(roles.setRole).not.toHaveBeenCalled();
      expect(settingModel.deleteOne).toHaveBeenCalledTimes(1);
      // A timed-out actor check is not "no longer an admin".
      const second = build();
      second.adminAccess.isAdminNow.mockRejectedValueOnce(new ClerkTimedOut());
      await expect(
        second.service.promote(ADMIN, MEMBER, 'r'),
      ).rejects.toBeInstanceOf(ClerkTimedOut);
    });

    it('on an unknown demotion: keeps the lock, still clears the cached role, and says to re-check (round 3)', async () => {
      const { service, roles, settingModel, adminAccess, directory } = build({
        identity: { role: 'admin' },
      });
      roles.setRole.mockRejectedValueOnce(new ClerkTimedOut());
      await expect(service.demote(ADMIN, OTHER, 'r')).rejects.toThrow(
        new ServiceUnavailableException(DEMOTION_UNKNOWN),
      );
      expect(adminAccess.forgetRole).toHaveBeenCalledWith(OTHER);
      expect(directory.revoke).not.toHaveBeenCalled();
      expect(settingModel.deleteOne).not.toHaveBeenCalled();
    });

    it('logs a timed-out invitation as unknown, never failed, and keeps the lock (round 3)', async () => {
      const { service, directory, log, settingModel } = build();
      directory.invite.mockRejectedValueOnce(new ClerkTimedOut());
      await expect(
        service.invite(ADMIN, 'late@example.org', 'admin', undefined),
      ).rejects.toThrow(new ServiceUnavailableException(OUTCOME_UNKNOWN));
      const actions = log.record.mock.calls.map(
        (call) => (call as unknown as [{ action: string }])[0].action,
      );
      expect(actions).toEqual(['invitation.requested', 'invitation.unknown']);
      const [requested, unknown] = log.record.mock.calls.map(
        (call) =>
          (call as unknown as [{ details: { attemptId: string } }])[0].details,
      );
      expect(unknown.attemptId).toBe(requested.attemptId);
      expect(settingModel.deleteOne).not.toHaveBeenCalled();
    });

    it('logs a timed-out withdrawal as unknown, and keeps the lock (round 3)', async () => {
      const { service, directory, log, settingModel } = build();
      directory.revoke.mockRejectedValueOnce(new ClerkTimedOut());
      await expect(service.revokeInvitation(ADMIN, 'inv_1')).rejects.toThrow(
        ClerkTimedOut,
      );
      expect(log.record).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'invitation.revoke.unknown' }),
      );
      expect(settingModel.deleteOne).not.toHaveBeenCalled();
    });

    it('stops withdrawing at a lost fence or an unknown outcome, and warns (round 3, LOW-2)', async () => {
      const pending = ['inv_a', 'inv_b', 'inv_c'].map((invitationId) => ({
        invitationId,
        email: `${invitationId}@example.org`,
        createdAt: new Date().toISOString(),
      }));
      const sent = pending.map(({ invitationId }) => ({
        action: 'invitation.sent',
        at: new Date(),
        details: { invitationId },
      }));
      const fenced = build({ identity: { role: 'admin' } });
      fenced.logModel.find.mockReturnValueOnce(chain(sent));
      fenced.directory.pendingInvitations.mockResolvedValueOnce({
        invitations: pending,
        complete: true,
      });
      // The fence holds for the role write and the first withdrawal only.
      fenced.settingModel.exists
        .mockReturnValueOnce({ exec: () => Promise.resolve({ _id: 'l' }) })
        .mockReturnValueOnce({ exec: () => Promise.resolve({ _id: 'l' }) })
        .mockReturnValue({ exec: () => Promise.resolve(null) } as never);
      await expect(
        fenced.service.demote(ADMIN, OTHER, 'r'),
      ).resolves.toStrictEqual({
        role: null,
        followUpWarning: FOLLOW_UP_WARNING,
      });
      expect(fenced.directory.revoke.mock.calls).toEqual([['inv_a']]);

      const timedOut = build({ identity: { role: 'admin' } });
      timedOut.logModel.find.mockReturnValueOnce(chain(sent));
      timedOut.directory.pendingInvitations.mockResolvedValueOnce({
        invitations: pending,
        complete: true,
      });
      timedOut.directory.revoke.mockRejectedValueOnce(new ClerkTimedOut());
      await expect(
        timedOut.service.demote(ADMIN, OTHER, 'r'),
      ).resolves.toStrictEqual({
        role: null,
        followUpWarning: FOLLOW_UP_WARNING,
      });
      expect(timedOut.directory.revoke).toHaveBeenCalledTimes(1);
      expect(timedOut.settingModel.deleteOne).not.toHaveBeenCalled();
    });

    it('never withdraws another admin’s later invitation to the same address (round 3, LOW-1)', async () => {
      const { service, logModel, directory } = build({
        identity: { role: 'admin' },
      });
      const day = 24 * 3600 * 1000;
      const old = new Date(Date.now() - 10 * day);
      const hash = emailForLog('x@example.org').emailHash;
      // A's old invitation to x@: requested and sent, the same attempt.
      logModel.find.mockReturnValueOnce(
        chain([
          {
            action: 'invitation.requested',
            at: old,
            details: { emailHash: hash, attemptId: 'a1' },
          },
          {
            action: 'invitation.sent',
            at: old,
            details: {
              emailHash: hash,
              attemptId: 'a1',
              invitationId: 'inv_old',
            },
          },
          // And one that failed: ended too.
          {
            action: 'invitation.requested',
            at: old,
            details: { emailHash: hash, attemptId: 'a2' },
          },
          {
            action: 'invitation.failed',
            at: old,
            details: { emailHash: hash, attemptId: 'a2' },
          },
        ]),
      );
      // B's new admin invitation to x@ (A's expired long ago).
      directory.pendingInvitations.mockResolvedValueOnce({
        invitations: [
          {
            invitationId: 'inv_from_b',
            email: 'x@example.org',
            role: 'admin',
            createdAt: new Date().toISOString(),
          },
        ],
        complete: true,
      });
      await expect(service.demote(ADMIN, OTHER, 'r')).resolves.toEqual({
        role: null,
      });
      expect(directory.revoke).not.toHaveBeenCalled();
    });

    it('matches an open request only inside its window', () => {
      const at = new Date('2026-11-13T10:00:00Z');
      const hash = emailForLog('x@example.org').emailHash;
      const { openWindows, sentIds } = invitationLeads([
        { action: 'invitation.requested', at, details: { emailHash: hash } },
      ]);
      expect(sentIds.size).toBe(0);
      const invitation = (offset: number) => ({
        invitationId: 'inv',
        email: 'x@example.org',
        role: 'admin' as const,
        createdAt: new Date(at.getTime() + offset).toISOString(),
      });
      expect(isTheirs(invitation(0), sentIds, openWindows)).toBe(true);
      expect(
        isTheirs(
          invitation(ROLE_CHANGE_DEADLINE_MS + INVITATION_MATCH_SLACK_MS),
          sentIds,
          openWindows,
        ),
      ).toBe(true);
      expect(
        isTheirs(
          invitation(ROLE_CHANGE_DEADLINE_MS + INVITATION_MATCH_SLACK_MS + 1),
          sentIds,
          openWindows,
        ),
      ).toBe(false);
      expect(
        isTheirs(
          invitation(-INVITATION_MATCH_SLACK_MS - 1),
          sentIds,
          openWindows,
        ),
      ).toBe(false);
      expect(
        isTheirs(
          { ...invitation(0), email: 'y@example.org' },
          sentIds,
          openWindows,
        ),
      ).toBe(false);
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

    it('withdraws the waiting admin invitations the demoted admin sent or may have sent (MEDIUM-3, round 2)', async () => {
      const { service, logModel, directory, log, order } = build({
        identity: { role: 'admin' },
      });
      const askedAt = new Date('2026-11-13T10:00:00Z');
      const hash = emailForLog('timed-out@example.org').emailHash;
      logModel.find.mockReturnValueOnce(
        chain([
          {
            action: 'invitation.sent',
            at: askedAt,
            details: { invitationId: 'inv_theirs', emailHash: 'h1' },
          },
          {
            action: 'invitation.sent',
            at: askedAt,
            details: { invitationId: 'inv_accepted', emailHash: 'h2' },
          },
          // A request that timed out: Clerk created it anyway.
          {
            action: 'invitation.requested',
            at: askedAt,
            details: { emailHash: hash },
          },
          {
            action: 'invitation.unknown',
            at: new Date(askedAt.getTime() + 5),
            details: { emailHash: hash },
          },
        ]),
      );
      directory.pendingInvitations.mockResolvedValueOnce({
        invitations: [
          {
            invitationId: 'inv_theirs',
            email: 'x@example.org',
            createdAt: askedAt.toISOString(),
          },
          {
            invitationId: 'inv_someone_else',
            email: 'y@example.org',
            role: 'admin',
            createdAt: askedAt.toISOString(),
          },
          {
            invitationId: 'inv_lost',
            email: 'timed-out@example.org',
            role: 'admin',
            createdAt: new Date(askedAt.getTime() + 2_000).toISOString(),
          },
          // Same address, but as a member, or long before: not theirs.
          {
            invitationId: 'inv_member',
            email: 'timed-out@example.org',
            createdAt: askedAt.toISOString(),
          },
          {
            invitationId: 'inv_old',
            email: 'timed-out@example.org',
            role: 'admin',
            createdAt: new Date(
              askedAt.getTime() -
                ROLE_CHANGE_DEADLINE_MS -
                2 * INVITATION_MATCH_SLACK_MS,
            ).toISOString(),
          },
        ],
        complete: true,
      });
      await expect(service.demote(ADMIN, OTHER, 'r')).resolves.toEqual({
        role: null,
      });
      expect(logModel.find).toHaveBeenCalledWith({
        actorUserId: OTHER,
        action: {
          $in: [
            'invitation.sent',
            'invitation.requested',
            'invitation.unknown',
            'invitation.failed',
          ],
        },
        'details.as': 'admin',
      });
      expect(directory.revoke.mock.calls).toEqual([
        ['inv_theirs'],
        ['inv_lost'],
      ]);
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

    it('still demotes when a follow-up fails, and says so in the answer (round 2, LOW 2)', async () => {
      const errorLog = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const { service, adminAccess, logModel, directory } = build({
        identity: { role: 'admin' },
      });
      adminAccess.forgetRole.mockRejectedValueOnce(new Error('cache'));
      logModel.find.mockReturnValueOnce(
        chain([{ action: 'invitation.sent', at: new Date(), details: {} }]),
      );
      directory.pendingInvitations.mockRejectedValueOnce(new Error('list'));
      await expect(service.demote(ADMIN, OTHER, 'r')).resolves.toStrictEqual({
        role: null,
        followUpWarning: FOLLOW_UP_WARNING,
      });
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('cache'));
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('list'));
      // A single revoke failing does not stop the others, and warns.
      const second = build({ identity: { role: 'admin' } });
      second.logModel.find.mockReturnValueOnce(
        chain([
          {
            action: 'invitation.sent',
            at: new Date(),
            details: { invitationId: 'inv_a' },
          },
          {
            action: 'invitation.sent',
            at: new Date(),
            details: { invitationId: 'inv_b' },
          },
        ]),
      );
      second.directory.pendingInvitations.mockResolvedValueOnce({
        invitations: [
          {
            invitationId: 'inv_a',
            email: 'a@example.org',
            createdAt: new Date().toISOString(),
          },
          {
            invitationId: 'inv_b',
            email: 'b@example.org',
            createdAt: new Date().toISOString(),
          },
        ],
        complete: true,
      });
      second.directory.revoke.mockRejectedValueOnce(new Error('gone'));
      await expect(
        second.service.demote(ADMIN, OTHER, 'r'),
      ).resolves.toStrictEqual({
        role: null,
        followUpWarning: FOLLOW_UP_WARNING,
      });
      expect(second.directory.revoke).toHaveBeenCalledTimes(2);
      // An invitation list cut short is a warning too.
      const third = build({ identity: { role: 'admin' } });
      third.logModel.find.mockReturnValueOnce(
        chain([{ action: 'invitation.sent', at: new Date(), details: {} }]),
      );
      third.directory.pendingInvitations.mockResolvedValueOnce({
        invitations: [],
        complete: false,
      });
      await expect(
        third.service.demote(ADMIN, OTHER, 'r'),
      ).resolves.toStrictEqual({
        role: null,
        followUpWarning: FOLLOW_UP_WARNING,
      });
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
        details: {
          as: 'admin',
          emailHash: hash,
          emailDomain: 'example.org',
          attemptId: expect.any(String) as unknown,
        },
      });
      expect(log.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'invitation.sent',
          details: {
            as: 'admin',
            emailHash: hash,
            emailDomain: 'example.org',
            attemptId: expect.any(String) as unknown,
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
