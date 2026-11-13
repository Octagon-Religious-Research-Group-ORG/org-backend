import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import {
  MAX_REASON_LENGTH,
  ROLE_AUDIT_INCOMPLETE_MESSAGE,
  RolesService,
} from './roles.service';
import { ClerkOutcomeUnknown, ClerkTimedOut } from './clerk-user-info.service';
import { settle, settledAs } from './write-outcome';

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
  actorUserId: 'user_admin',
  targetUserId: 'user_member',
  role: 'moderator' as const,
  reason: '  Helps with moderation  ',
};

const entry = {
  actorUserId: 'user_admin',
  targetType: 'user',
  targetId: 'user_member',
  reason: 'Helps with moderation',
};

describe('RolesService.setRole', () => {
  it('treats any unmarked error from the write as unknown, and says so (round 5)', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { service, clerk, log } = setup('admin');
    const onUnknown = jest.fn(() => {
      throw new Error('hook broke');
    });
    clerk.setRole.mockRejectedValueOnce(new RangeError('Invalid time value'));
    await expect(
      service.setRole({ ...change, onUnknown }),
    ).rejects.toBeInstanceOf(ClerkOutcomeUnknown);
    expect(onUnknown).toHaveBeenCalled();
    // A throwing hook neither replaces the outcome nor skips the entry.
    expect(log.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'role.change.timeout' }),
    );
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('hook broke'));
    logged.mockRestore();
  });

  it('marks every failure before the send as not sent', async () => {
    const { service, clerk, log } = setup();
    log.record.mockRejectedValueOnce(new Error('requested entry failed'));
    const error = await service.setRole(change).catch((e: unknown) => e);
    expect(settledAs(error)).toBe('not-sent');
    expect(clerk.setRole).not.toHaveBeenCalled();
    clerk.getIdentity.mockRejectedValueOnce('raw read failure');
    const raw = await service.setRole(change).catch((e: unknown) => e);
    expect(settledAs(raw)).toBe('not-sent');
  });

  it('marks a change whose final entry failed as applied', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { service, log } = setup();
    log.record
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('db down'));
    const error = await service.setRole(change).catch((e: unknown) => e);
    expect(settledAs(error)).toBe('applied');
    logged.mockRestore();
  });

  it('never lets a failing log write replace an unknown outcome (round 4, MEDIUM-1)', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { service, clerk, log } = setup('admin');
    const onUnknown = jest.fn();
    clerk.setRole.mockRejectedValueOnce(new ClerkTimedOut());
    log.record.mockResolvedValueOnce({}).mockRejectedValueOnce('mongo down');
    await expect(
      service.setRole({ ...change, onUnknown }),
    ).rejects.toBeInstanceOf(ClerkTimedOut);
    // The caller heard it first, before the log write was even tried.
    expect(onUnknown.mock.invocationCallOrder[0]).toBeLessThan(
      log.record.mock.invocationCallOrder[1],
    );
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('mongo down'));
    // A failed "failed" entry does not replace the refusal either.
    clerk.setRole.mockRejectedValueOnce(
      settle(new Error('refused'), 'refused'),
    );
    log.record
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('mongo down again'));
    await expect(service.setRole(change)).rejects.toThrow('refused');
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('mongo down again'),
    );
    logged.mockRestore();
  });

  it('logs a Clerk timeout as an unknown outcome, never as failed (review round 3)', async () => {
    const { service, clerk, log } = setup('admin');
    clerk.setRole.mockRejectedValueOnce(new ClerkTimedOut());
    await expect(service.setRole(change)).rejects.toBeInstanceOf(ClerkTimedOut);
    const actions = log.record.mock.calls.map(
      (call) => (call as unknown as [{ action: string }])[0].action,
    );
    expect(actions).toEqual(['role.change.requested', 'role.change.timeout']);
    expect(log.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        details: { from: 'admin', to: 'moderator', outcome: 'unknown' },
      }),
    );
  });

  it('says the role changed when only the final audit entry fails', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { service, clerk, log } = setup();
    log.record
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('db down'));

    const refusal = service.setRole(change);

    await expect(refusal).rejects.toBeInstanceOf(InternalServerErrorException);
    await expect(refusal).rejects.toThrow(ROLE_AUDIT_INCOMPLETE_MESSAGE);
    expect(clerk.setRole).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('db down'));
    logged.mockRestore();
  });

  it('reports a non-Error audit failure the same way', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { service, log } = setup();
    log.record.mockResolvedValueOnce({}).mockRejectedValueOnce('down');

    await expect(service.setRole(change)).rejects.toThrow(
      ROLE_AUDIT_INCOMPLETE_MESSAGE,
    );
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('down'));
    logged.mockRestore();
  });

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
    [
      'an Error',
      settle(new Error('Clerk refused'), 'refused'),
      'Clerk refused',
    ],
    ['a non-Error value', settle('boom', 'refused'), 'boom'],
    ['a plain object', settle({ status: 422 }, 'refused'), '[object Object]'],
  ])(
    'logs a change Clerk refused as failed, and rethrows %s',
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
