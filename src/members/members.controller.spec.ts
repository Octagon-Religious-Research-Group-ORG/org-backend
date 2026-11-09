/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-floating-promises */
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.types';
import {
  AdminSettingsController,
  MembersController,
  MyMemberPageController,
  PRIVATE_PICTURE_CACHE,
  PUBLIC_PICTURE_CACHE,
} from './members.controller';
import type { MembersService } from './members.service';
import type { MyMemberPageService } from './my-member-page.service';
import type { OrgSettingsService } from './org-settings.service';

const request = {
  auth: { payload: { sub: 'u1' } },
  headers: {},
} as unknown as AuthenticatedRequest;

function response() {
  const res = {
    set: jest.fn(() => res),
    status: jest.fn(() => res),
    end: jest.fn(() => res),
  };
  return res;
}

function members(isPublic: boolean) {
  const viewer = { kind: 'guest', isAdmin: false };
  return {
    viewer,
    service: {
      resolveViewer: jest.fn(() => Promise.resolve(viewer)),
      directory: jest.fn(() => Promise.resolve('directory')),
      chats: jest.fn(() => Promise.resolve('chats')),
      profile: jest.fn(() => Promise.resolve('profile')),
      picture: jest.fn(() =>
        Promise.resolve({
          picture: { data: Buffer.from('w'), fileId: 'f1' },
          isPublic,
        }),
      ),
    },
  };
}

describe('MembersController', () => {
  it('passes the resolved viewer to each read', async () => {
    const { service, viewer } = members(true);
    const controller = new MembersController(
      service as unknown as MembersService,
    );
    await expect(controller.directory(request)).resolves.toBe('directory');
    await expect(controller.chats(request)).resolves.toBe('chats');
    await expect(controller.profile(request, 'x')).resolves.toBe('profile');
    expect(service.directory).toHaveBeenCalledWith(viewer);
    expect(service.chats).toHaveBeenCalledWith(viewer);
    expect(service.profile).toHaveBeenCalledWith('x', viewer);
  });

  it('never lets a restricted picture be cached or loaded cross-origin', async () => {
    const { service } = members(false);
    const res = response();
    await new MembersController(service as unknown as MembersService).picture(
      request,
      res,
      'x',
    );
    expect(res.set).toHaveBeenCalledTimes(1);
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': 'image/webp',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': PRIVATE_PICTURE_CACHE,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.end).toHaveBeenCalledWith(Buffer.from('w'));
  });

  it('serves a public picture with a tag, and revalidates every time', async () => {
    const { service } = members(true);
    const res = response();
    await new MembersController(service as unknown as MembersService).picture(
      request,
      res,
      'x',
    );
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({ 'Cache-Control': PUBLIC_PICTURE_CACHE }),
    );
    expect(res.set).toHaveBeenCalledWith({
      ETag: '"f1"',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.end).toHaveBeenCalledWith(Buffer.from('w'));
  });

  it('answers 304 when the browser already holds the public picture', async () => {
    const { service } = members(true);
    const res = response();
    await new MembersController(service as unknown as MembersService).picture(
      { ...request, headers: { 'if-none-match': '"f1"' } } as never,
      res,
      'x',
    );
    expect(res.status).toHaveBeenCalledWith(304);
    expect(res.end).toHaveBeenCalledWith();
  });
});

describe('MyMemberPageController', () => {
  const page = {
    changeVisibility: jest.fn(() => 'visibility'),
    addBeliefTab: jest.fn(() => 'tab'),
    replacePicture: jest.fn(() => 'picture'),
  };
  const controller = new MyMemberPageController(
    page as unknown as MyMemberPageService,
  );

  it('uses the id from the token for every write', () => {
    expect(
      controller.changeVisibility(request, { visibility: 'unlisted' }),
    ).toBe('visibility');
    const dto = { title: 'T', text: 'x' };
    expect(controller.addTab(request, dto)).toBe('tab');
    expect(page.changeVisibility).toHaveBeenCalledWith('u1', 'unlisted');
    expect(page.addBeliefTab).toHaveBeenCalledWith('u1', dto);
  });

  it('passes the uploaded bytes, or nothing when no file came', () => {
    const buffer = Buffer.from('x');
    expect(controller.replacePicture(request, { buffer })).toBe('picture');
    expect(page.replacePicture).toHaveBeenLastCalledWith('u1', buffer);
    controller.replacePicture(request, undefined);
    expect(page.replacePicture).toHaveBeenLastCalledWith('u1', undefined);
  });
});

describe('AdminSettingsController', () => {
  it('sets the invite as the signed-in admin', () => {
    const settings = { setVotingInvite: jest.fn(() => 'done') };
    const controller = new AdminSettingsController(
      settings as unknown as OrgSettingsService,
    );
    expect(controller.setVotingInvite(request, { inviteUrl: 'u' })).toBe(
      'done',
    );
    expect(settings.setVotingInvite).toHaveBeenCalledWith('u', 'u1');
  });
});
