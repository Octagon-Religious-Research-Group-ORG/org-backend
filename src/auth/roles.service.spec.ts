import { BadRequestException } from '@nestjs/common';
import { MAX_REASON_LENGTH, RolesService } from './roles.service';

function setup(currentRole?: string) {
  const clerk = {
    getIdentity: jest.fn().mockResolvedValue({
      emailVerified: true,
      ...(currentRole ? { role: currentRole } : {}),
    }),
    setRole: jest.fn().mockResolvedValue(undefined),
  };
  const log = { record: jest.fn().mockResolvedValue({}) };
  const service = new RolesService(clerk as never, log as never);
  return { service, clerk, log };
}

const change = {
  actorUserId: 'user_tripp',
  targetUserId: 'user_member',
  role: 'moderator' as const,
  reason: '  Helps with moderation  ',
};

const entry = {
  actorUserId: 'user_tripp',
  targetType: 'user',
  targetId: 'user_member',
  reason: 'Helps with moderation',
};

describe('RolesService.setRole', () => {
  it('logs the request, changes the role, then logs that it was applied', async () => {
    const { service, clerk, log } = setup();

    await service.setRole(change);

    expect(clerk.setRole).toHaveBeenCalledWith('user_member', 'moderator');
    expect(log.record.mock.calls).toEqual([
      [
        {
          ...entry,
          action: 'role.change.requested',
          details: { from: null, to: 'moderator' },
        },
      ],
      [
        {
          ...entry,
          action: 'role.change.applied',
          details: { from: null, to: 'moderator' },
        },
      ],
    ]);
    expect(log.record.mock.invocationCallOrder[0]).toBeLessThan(
      clerk.setRole.mock.invocationCallOrder[0],
    );
  });

  it('records the previous role when removing one', async () => {
    const { service, clerk, log } = setup('admin');

    await service.setRole({ ...change, role: null });

    expect(clerk.setRole).toHaveBeenCalledWith('user_member', null);
    expect(log.record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ details: { from: 'admin', to: null } }),
    );
  });

  it.each([
    ['an Error', new Error('Clerk is down'), 'Clerk is down'],
    ['a non-Error value', 'boom', 'boom'],
  ])(
    'logs a failed change and rethrows %s',
    async (_label, thrown, message) => {
      const { service, clerk, log } = setup();
      clerk.setRole.mockRejectedValueOnce(thrown);

      await expect(service.setRole(change)).rejects.toBe(thrown);

      expect(log.record).toHaveBeenCalledTimes(2);
      expect(log.record).toHaveBeenNthCalledWith(2, {
        ...entry,
        action: 'role.change.failed',
        details: { from: null, to: 'moderator', error: message },
      });
    },
  );

  it.each([
    ['blank', '   '],
    ['too long', 'x'.repeat(MAX_REASON_LENGTH + 1)],
  ])(
    'refuses a %s reason before touching Clerk or the log',
    async (_label, reason) => {
      const { service, clerk, log } = setup();

      await expect(
        service.setRole({ ...change, reason }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(clerk.getIdentity).not.toHaveBeenCalled();
      expect(log.record).not.toHaveBeenCalled();
    },
  );
});
