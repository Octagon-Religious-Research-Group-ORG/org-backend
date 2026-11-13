import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminRoleGuard } from '../../auth/admin-role.guard';
import { ClerkAuthGuard } from '../../auth/auth.guard';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { MemberWriteThrottleGuard } from '../member-write-throttle.guard';
import {
  AdminDashboardController,
  AdminDashboardWritesController,
  MyEamRequestController,
  MyEamRequestWritesController,
  NO_SUCH_ACCOUNT,
} from './admin.controller';

const ADMIN = 'user_admin';
const request = (sub: string) =>
  ({
    auth: { payload: { sub } },
    headers: {},
  }) as unknown as AuthenticatedRequest;

function setup() {
  const resolved = (value: string) => jest.fn(() => Promise.resolve(value));
  const roles = {
    admins: resolved('admins'),
    invitations: jest.fn(() =>
      Promise.resolve({ invitations: ['inv'], complete: true }),
    ),
    promote: resolved('promoted'),
    demote: resolved('demoted'),
    invite: resolved('invited'),
    revokeInvitation: resolved('revoked'),
  };
  const members = {
    list: resolved('members'),
    approve: resolved('approved'),
    reject: resolved('rejected'),
    remove: resolved('removed'),
    restore: resolved('restored'),
  };
  const log = { page: resolved('log') };
  const inbox = {
    list: resolved('inbox'),
    markHandled: resolved('handled'),
    resetEam: resolved('reset'),
  };
  const settings = { adminView: resolved('settings') };
  const viewer = { kind: 'named-member', userId: 'user_m', isAdmin: false };
  const memberService = {
    resolveViewer: jest.fn(() => Promise.resolve(viewer)),
  };
  const eam = { status: resolved('status'), request: resolved('asked') };
  return { roles, members, log, inbox, settings, memberService, eam, viewer };
}

describe('admin dashboard controllers', () => {
  it('guard every route with sign-in and the real admin role; writes are rationed', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AdminDashboardController),
    ).toEqual([ClerkAuthGuard, AdminRoleGuard]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AdminDashboardWritesController),
    ).toEqual([ClerkAuthGuard, AdminRoleGuard, MemberWriteThrottleGuard]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, MyEamRequestController),
    ).toEqual([ClerkAuthGuard]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, MyEamRequestWritesController),
    ).toEqual([ClerkAuthGuard, MemberWriteThrottleGuard]);
  });

  it('read with the defaults the screens rely on', async () => {
    const s = setup();
    const reads = new AdminDashboardController(
      s.roles as never,
      s.members as never,
      s.log as never,
      s.inbox as never,
      s.settings as never,
    );
    await expect(reads.admins(request(ADMIN))).resolves.toBe('admins');
    expect(s.roles.admins).toHaveBeenCalledWith(ADMIN);
    await expect(reads.invitations()).resolves.toEqual({
      invitations: ['inv'],
      complete: true,
    });
    await reads.memberPages({});
    expect(s.members.list).toHaveBeenCalledWith('all', undefined, 1);
    await reads.memberPages({ status: 'pending', q: 'fern', page: 3 });
    expect(s.members.list).toHaveBeenLastCalledWith('pending', 'fern', 3);
    await reads.moderationLog({});
    expect(s.log.page).toHaveBeenCalledWith(1);
    await reads.moderationLog({ page: 2 });
    expect(s.log.page).toHaveBeenLastCalledWith(2);
    await reads.inboxEntries({});
    expect(s.inbox.list).toHaveBeenCalledWith('open', 1);
    await reads.inboxEntries({ status: 'handled', page: 4 });
    expect(s.inbox.list).toHaveBeenLastCalledWith('handled', 4);
    await expect(reads.allSettings()).resolves.toBe('settings');
  });

  it('pass the admin from the token to every write', async () => {
    const s = setup();
    const writes = new AdminDashboardWritesController(
      s.roles as never,
      s.members as never,
      s.inbox as never,
    );
    const r = request(ADMIN);
    await expect(writes.promote(r, 'user_new', { reason: 'x' })).resolves.toBe(
      'promoted',
    );
    expect(s.roles.promote).toHaveBeenCalledWith(ADMIN, 'user_new', 'x');
    await writes.demote(r, 'user_old', { reason: 'y' });
    expect(s.roles.demote).toHaveBeenCalledWith(ADMIN, 'user_old', 'y');
    await writes.invite(r, { email: 'a@example.org', as: 'member' });
    expect(s.roles.invite).toHaveBeenCalledWith(
      ADMIN,
      'a@example.org',
      'member',
      undefined,
    );
    await writes.revoke(r, 'inv_abc');
    expect(s.roles.revokeInvitation).toHaveBeenCalledWith(ADMIN, 'inv_abc');
    await writes.approve(r, 'a-page');
    expect(s.members.approve).toHaveBeenCalledWith(ADMIN, 'a-page');
    await writes.reject(r, 'a-page', { reason: 'r1' });
    expect(s.members.reject).toHaveBeenCalledWith(ADMIN, 'a-page', 'r1');
    await writes.remove(r, 'a-page', { reason: 'r2' });
    expect(s.members.remove).toHaveBeenCalledWith(ADMIN, 'a-page', 'r2');
    await writes.restore(r, 'a-page', { reason: 'r3' });
    expect(s.members.restore).toHaveBeenCalledWith(ADMIN, 'a-page', 'r3');
    await writes.handled(r, 'e1');
    expect(s.inbox.markHandled).toHaveBeenCalledWith(ADMIN, 'e1');
    await writes.resetEam(r, 'e2');
    expect(s.inbox.resetEam).toHaveBeenCalledWith(ADMIN, 'e2');
  });

  it('answer a malformed account or invitation id as not found', () => {
    const s = setup();
    const writes = new AdminDashboardWritesController(
      s.roles as never,
      s.members as never,
      s.inbox as never,
    );
    const r = request(ADMIN);
    expect(() => writes.promote(r, 'admin', { reason: 'x' })).toThrow(
      new NotFoundException(NO_SUCH_ACCOUNT),
    );
    expect(() => writes.demote(r, 'user_../x', { reason: 'x' })).toThrow(
      NotFoundException,
    );
    expect(() => writes.revoke(r, 'user_1')).toThrow(NotFoundException);
    expect(s.roles.promote).not.toHaveBeenCalled();
    expect(s.roles.revokeInvitation).not.toHaveBeenCalled();
  });

  it('give the member their own EaM state, and ask with the verified id', async () => {
    const s = setup();
    const reads = new MyEamRequestController(
      s.memberService as never,
      s.eam as never,
    );
    await expect(reads.status(request('user_m'))).resolves.toBe('status');
    expect(s.eam.status).toHaveBeenCalledWith({
      ...s.viewer,
      userId: 'user_m',
    });
    const writes = new MyEamRequestWritesController(
      s.memberService as never,
      s.eam as never,
    );
    await expect(
      writes.request(request('user_m'), { note: 'hi' }),
    ).resolves.toBe('asked');
    expect(s.eam.request).toHaveBeenCalledWith(
      { ...s.viewer, userId: 'user_m' },
      'hi',
    );
  });
});
