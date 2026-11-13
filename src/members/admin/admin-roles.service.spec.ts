import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ADMINS_UNCOUNTABLE,
  ALREADY_ADMIN,
  AdminRolesService,
  LAST_ADMIN,
  NOT_A_MEMBER,
  NOT_ADMIN,
  OWN_DEMOTION,
  ROLE_CHANGE_BUSY,
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
    role?: string;
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
    invite: jest.fn((email: string, role: string | null) => {
      order.push('clerk');
      return Promise.resolve({
        invitationId: 'inv_1',
        email,
        ...(role ? { role } : {}),
        createdAt: '2026-11-13T00:00:00.000Z',
      });
    }),
    pendingInvitations: jest.fn(() => Promise.resolve([])),
    revoke: jest.fn(() => {
      order.push('clerk');
      return Promise.resolve();
    }),
  };
  const clerk = {
    getIdentity: jest.fn(() =>
      Promise.resolve(options.role ? { role: options.role } : {}),
    ),
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
  };
  const profileModel = { find: jest.fn(() => chain([])) };
  const service = new AdminRolesService(
    { getOrThrow: () => 'https://org.example/' } as never,
    directory as never,
    clerk as never,
    roles as never,
    log as never,
    settingModel as never,
    profileModel as never,
  );
  return {
    service,
    directory,
    clerk,
    roles,
    log,
    settingModel,
    profileModel,
    order,
  };
}

describe('AdminRolesService', () => {
  it('lists the admins with their pages, and marks you', async () => {
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

  describe('promote', () => {
    it('takes the lock, changes the role through RolesService, then frees it', async () => {
      const { service, roles, settingModel, order } = build();
      await expect(
        service.promote(ADMIN, MEMBER, 'Synthetic reason'),
      ).resolves.toEqual({
        role: 'admin',
      });
      expect(roles.setRole).toHaveBeenCalledWith({
        actorUserId: ADMIN,
        targetUserId: MEMBER,
        role: 'admin',
        reason: 'Synthetic reason',
      });
      expect(order).toEqual(['lock', 'setRole', 'unlock']);
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
      expect(settingModel.deleteOne).toHaveBeenCalledWith({
        key: ROLE_LOCK_KEY,
        value: update.$set.value,
      });
    });

    it('refuses someone already an admin, and still frees the lock', async () => {
      const { service, roles, order } = build({ role: 'admin' });
      await expect(service.promote(ADMIN, OTHER, 'r')).rejects.toThrow(
        new ConflictException(ALREADY_ADMIN),
      );
      expect(roles.setRole).not.toHaveBeenCalled();
      expect(order).toEqual(['lock', 'unlock']);
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
  });

  describe('demote', () => {
    it('removes another admin’s role when another admin remains', async () => {
      const { service, roles, order } = build({ role: 'admin' });
      await expect(
        service.demote(ADMIN, OTHER, 'Stepping back'),
      ).resolves.toEqual({
        role: null,
      });
      expect(roles.setRole).toHaveBeenCalledWith({
        actorUserId: ADMIN,
        targetUserId: OTHER,
        role: null,
        reason: 'Stepping back',
      });
      expect(order).toEqual(['lock', 'setRole', 'unlock']);
    });

    it('never removes your own role, before taking the lock', async () => {
      const { service, settingModel } = build({ role: 'admin' });
      await expect(service.demote(ADMIN, ADMIN, 'r')).rejects.toThrow(
        new ForbiddenException(OWN_DEMOTION),
      );
      expect(settingModel.updateOne).not.toHaveBeenCalled();
    });

    it('never removes the last admin', async () => {
      const { service, roles } = build({
        role: 'admin',
        holders: [{ userId: OTHER }],
      });
      await expect(service.demote(ADMIN, OTHER, 'r')).rejects.toThrow(
        new ConflictException(LAST_ADMIN),
      );
      expect(roles.setRole).not.toHaveBeenCalled();
    });

    it('refuses when the admins cannot all be counted', async () => {
      const { service, roles } = build({ role: 'admin', complete: false });
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

    it('frees the lock when the role change fails', async () => {
      const { service, roles, order } = build({ role: 'admin' });
      roles.setRole.mockRejectedValueOnce(new Error('synthetic Clerk outage'));
      await expect(service.demote(ADMIN, OTHER, 'r')).rejects.toThrow(
        'synthetic Clerk outage',
      );
      expect(order.at(-1)).toBe('unlock');
    });
  });

  describe('invitations', () => {
    it('lists the waiting ones', async () => {
      const { service, directory } = build();
      await expect(service.invitations()).resolves.toEqual([]);
      expect(directory.pendingInvitations).toHaveBeenCalled();
    });

    it('logs the request before Clerk, then that it was sent', async () => {
      const { service, directory, log, order } = build();
      await service.invite(ADMIN, ' New@Example.ORG ', 'admin', undefined);
      expect(directory.invite).toHaveBeenCalledWith(
        'new@example.org',
        'admin',
        'https://org.example/community',
      );
      expect(order).toEqual([
        'invitation.requested',
        'clerk',
        'invitation.sent',
      ]);
      expect(log.record).toHaveBeenNthCalledWith(1, {
        actorUserId: ADMIN,
        targetType: 'invitation',
        targetId: 'new@example.org',
        reason: 'Admin invited a new admin.',
        action: 'invitation.requested',
        details: { as: 'admin' },
      });
      expect(log.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'invitation.sent',
          details: { as: 'admin', invitationId: 'inv_1' },
        }),
      );
    });

    it('invites a member with no role, keeping the reason given', async () => {
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
      );
      expect(log.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'Met at a meeting' }),
      );
      await service.invite(ADMIN, 'n@example.org', 'member', '   ');
      expect(log.record).toHaveBeenLastCalledWith(
        expect.objectContaining({ reason: 'Admin invited a new member.' }),
      );
    });

    it('logs a failed invitation and passes the refusal on', async () => {
      const { service, directory, log } = build();
      directory.invite.mockRejectedValueOnce(new ConflictException('dup'));
      await expect(
        service.invite(ADMIN, 'a@example.org', 'member', undefined),
      ).rejects.toThrow(ConflictException);
      expect(log.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'invitation.failed',
          details: { as: 'member', error: 'dup' },
        }),
      );
      directory.invite.mockRejectedValueOnce('raw');
      await expect(
        service.invite(ADMIN, 'a@example.org', 'member', undefined),
      ).rejects.toBe('raw');
      expect(log.record).toHaveBeenLastCalledWith(
        expect.objectContaining({ details: { as: 'member', error: 'raw' } }),
      );
    });

    it('revokes with the same before-and-after trail', async () => {
      const { service, directory, order, log } = build();
      await expect(service.revokeInvitation(ADMIN, 'inv_1')).resolves.toEqual({
        revoked: true,
      });
      expect(order).toEqual([
        'invitation.revoke.requested',
        'clerk',
        'invitation.revoke.applied',
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
      directory.revoke.mockRejectedValueOnce('raw');
      await expect(service.revokeInvitation(ADMIN, 'inv_1')).rejects.toBe(
        'raw',
      );
      expect(log.record).toHaveBeenLastCalledWith(
        expect.objectContaining({ details: { error: 'raw' } }),
      );
    });
  });
});
