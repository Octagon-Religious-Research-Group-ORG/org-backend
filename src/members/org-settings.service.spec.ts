import { BadRequestException } from '@nestjs/common';
import { OrgSettingsService } from './org-settings.service';

function setup(value?: string) {
  const calls: string[] = [];
  const query = {
    select: () => query,
    lean: () => query,
    exec: () => Promise.resolve(value === undefined ? null : { value }),
  };
  const model = {
    findOne: jest.fn(() => query),
    updateOne: jest.fn(() => ({
      exec: () => {
        calls.push('write');
        return Promise.resolve({});
      },
    })),
    deleteOne: jest.fn(() => ({
      exec: () => {
        calls.push('delete');
        return Promise.resolve({});
      },
    })),
  };
  const log = {
    record: jest.fn((entry: { action: string }) => {
      calls.push(entry.action);
      return Promise.resolve({});
    }),
  };
  return {
    service: new OrgSettingsService(model as never, log as never),
    model,
    log,
    calls,
  };
}

describe('OrgSettingsService', () => {
  it('shows the admins every setting (Chunk 12)', async () => {
    await expect(setup().service.adminView()).resolves.toEqual({
      anonymousMayVote: false,
    });
    // One stored value answers both reads here: the invite is shown, and
    // anything but `on` reads as anonymous voting off.
    await expect(
      setup('https://t.me/+synthetic').service.adminView(),
    ).resolves.toEqual({
      votingInvite: 'https://t.me/+synthetic',
      anonymousMayVote: false,
    });
  });

  it('keeps anonymous voting off unless set to on (Chunk 10)', async () => {
    await expect(setup().service.anonymousMayVote()).resolves.toBe(false);
    await expect(setup('off').service.anonymousMayVote()).resolves.toBe(false);
    await expect(setup('yes').service.anonymousMayVote()).resolves.toBe(false);
    await expect(setup('on').service.anonymousMayVote()).resolves.toBe(true);
  });

  it.each([true, false])(
    'sets anonymous voting to %s, audited before and after',
    async (on) => {
      const { service, calls, model, log } = setup();
      await expect(service.setAnonymousMayVote(on, 'admin_1')).resolves.toEqual(
        { anonymousMayVote: on },
      );
      expect(calls).toEqual([
        'setting.change.requested',
        'write',
        'setting.change.applied',
      ]);
      expect(model.updateOne).toHaveBeenCalledWith(
        { key: 'anonymous-may-vote' },
        { $set: { value: on ? 'on' : 'off', updatedBy: 'admin_1' } },
        { upsert: true, runValidators: true },
      );
      expect(log.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'admin_1',
          targetId: 'anonymous-may-vote',
          details: { anonymousMayVote: on },
        }),
      );
    },
  );

  it('reads the invite, or nothing when unset', async () => {
    await expect(setup('https://t.me/+a').service.votingInvite()).resolves.toBe(
      'https://t.me/+a',
    );
    await expect(setup().service.votingInvite()).resolves.toBeUndefined();
  });

  it('writes the audit entry before the change and after it', async () => {
    const { service, calls, model } = setup();
    await expect(
      service.setVotingInvite(' https://t.me/+AbC_d-1 ', 'admin_1'),
    ).resolves.toEqual({ set: true });
    expect(calls).toEqual([
      'setting.change.requested',
      'write',
      'setting.change.applied',
    ]);
    expect(model.updateOne).toHaveBeenCalledWith(
      { key: 'voting-invite' },
      { $set: { value: 'https://t.me/+AbC_d-1', updatedBy: 'admin_1' } },
      { upsert: true, runValidators: true },
    );
  });

  it('never writes the invite itself into the audit log', async () => {
    const { service, log } = setup();
    await service.setVotingInvite('https://t.me/+AbC', 'admin_1');
    expect(JSON.stringify(log.record.mock.calls)).not.toContain('+AbC');
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'admin_1',
        targetType: 'org-setting',
        targetId: 'voting-invite',
      }),
    );
  });

  it('clears the invite on an empty address, audited', async () => {
    const { service, calls, log } = setup();
    await expect(service.setVotingInvite('  ', 'admin_1')).resolves.toEqual({
      set: false,
    });
    expect(calls).toEqual([
      'setting.change.requested',
      'delete',
      'setting.change.applied',
    ]);
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({ details: { cleared: true } }),
    );
  });

  it.each([
    'http://t.me/+a',
    'https://t.me.evil.example/+a',
    'javascript:alert(1)',
    'https://t.me/+a/../b',
    'https://example.test/+a',
  ])('refuses %s and audits nothing', async (url) => {
    const { service, log, model } = setup();
    await expect(
      service.setVotingInvite(url, 'admin_1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(log.record).not.toHaveBeenCalled();
    expect(model.updateOne).not.toHaveBeenCalled();
  });
});
