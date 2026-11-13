import type { AuthenticatedRequest } from '../../auth/auth.types';
import type { MembersService } from '../members.service';
import {
  AdminClaimsController,
  AdminClaimWritesController,
  MyClaimsController,
  MyClaimWritesController,
} from './claims.controller';
import type { ClaimsService } from './claims.service';
import type { LegacyLinksService } from './legacy-links.service';

const request = (sub: string) =>
  ({
    auth: { payload: { sub } },
    headers: {},
  }) as unknown as AuthenticatedRequest;

function setup() {
  const viewer = { kind: 'signed-in', userId: 'user_c', isAdmin: false };
  const members = {
    resolveViewer: jest.fn(() => Promise.resolve(viewer)),
  } as unknown as MembersService;
  const claims = {
    mine: jest.fn(() => Promise.resolve('mine')),
    request: jest.fn(() => Promise.resolve('requested')),
    withdraw: jest.fn(() => Promise.resolve('withdrawn')),
    adminList: jest.fn(() => Promise.resolve('list')),
    approve: jest.fn(() => Promise.resolve('approved')),
    reject: jest.fn(() => Promise.resolve('rejected')),
  };
  const links = {
    candidates: jest.fn(() => Promise.resolve('candidates')),
    link: jest.fn(() => Promise.resolve('linked')),
    unlink: jest.fn(() => Promise.resolve('unlinked')),
  };
  return {
    viewer,
    members,
    claims,
    links,
    service: claims as unknown as ClaimsService,
    linkService: links as unknown as LegacyLinksService,
  };
}

describe('claims controllers', () => {
  it('give the claimant only their own requests, by the verified token', async () => {
    const { claims, service, members, viewer } = setup();
    await expect(
      new MyClaimsController(service).mine(request('user_c')),
    ).resolves.toBe('mine');
    expect(claims.mine).toHaveBeenCalledWith('user_c');

    const writes = new MyClaimWritesController(members, service);
    await expect(
      writes.request(request('user_c'), { slug: 'a-page', message: 'hi' }),
    ).resolves.toBe('requested');
    expect(claims.request).toHaveBeenCalledWith(
      { ...viewer, userId: 'user_c' },
      'a-page',
      'hi',
    );
    await expect(writes.withdraw(request('user_c'), 'abc')).resolves.toBe(
      'withdrawn',
    );
    expect(claims.withdraw).toHaveBeenCalledWith('user_c', 'abc');
  });

  it('pass the admin’s id from the token to every decision', async () => {
    const { claims, links, service, linkService } = setup();
    const reads = new AdminClaimsController(service, linkService);
    await expect(reads.list({})).resolves.toBe('list');
    expect(claims.adminList).toHaveBeenCalledWith('pending');
    await reads.list({ status: 'approved' });
    expect(claims.adminList).toHaveBeenLastCalledWith('approved');
    await expect(reads.legacyComments('abc')).resolves.toBe('candidates');
    expect(links.candidates).toHaveBeenCalledWith('abc');

    const writes = new AdminClaimWritesController(service, linkService);
    const admin = request('user_admin');
    await expect(writes.approve(admin, 'abc')).resolves.toBe('approved');
    expect(claims.approve).toHaveBeenCalledWith('user_admin', 'abc');
    await expect(writes.reject(admin, 'abc', { reason: 'r' })).resolves.toBe(
      'rejected',
    );
    expect(claims.reject).toHaveBeenCalledWith('user_admin', 'abc', 'r');
    await expect(
      writes.link(admin, 'abc', { commentIds: ['c1'] }),
    ).resolves.toBe('linked');
    expect(links.link).toHaveBeenCalledWith('user_admin', 'abc', ['c1']);
    await expect(
      writes.unlink(admin, 'abc', { commentIds: ['c1'] }),
    ).resolves.toBe('unlinked');
    expect(links.unlink).toHaveBeenCalledWith('user_admin', 'abc', ['c1']);
  });
});
