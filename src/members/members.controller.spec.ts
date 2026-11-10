/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-floating-promises */
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { MemberJsonCacheInterceptor } from './no-store.interceptor';
import {
  AdminSettingsController,
  MembersController,
  MyMemberPageController,
  PRIVATE_PICTURE_CACHE,
  PUBLIC_PICTURE_CACHE,
} from './members.controller';
import type { MemberHistoryService } from './member-history.service';
import type { MemberPageEditorService } from './member-page-editor.service';
import type { MembersService } from './members.service';

const NO_HISTORY = {} as MemberHistoryService;
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
      NO_HISTORY,
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
    await new MembersController(
      service as unknown as MembersService,
      NO_HISTORY,
    ).picture(request, res, 'x');
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
    await new MembersController(
      service as unknown as MembersService,
      NO_HISTORY,
    ).picture(request, res, 'x');
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
    await new MembersController(
      service as unknown as MembersService,
      NO_HISTORY,
    ).picture(
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
  const editor = {
    editBio: jest.fn(() => 'bio'),
    editTabText: jest.fn(() => 'text'),
    editTabTitle: jest.fn(() => 'title'),
    moveTab: jest.fn(() => 'moved'),
    removeTab: jest.fn(() => 'removed'),
  };
  const controller = new MyMemberPageController(
    page as unknown as MyMemberPageService,
    editor as unknown as MemberPageEditorService,
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

  it('takes the editor from the token, never from the body or the path', () => {
    expect(controller.editBio(request, { text: 'b', baseSeq: 2 })).toBe('bio');
    expect(
      controller.editTabText(request, 'tab_1', { text: 't', baseSeq: 3 }),
    ).toBe('text');
    expect(
      controller.editTabTitle(request, 'tab_1', { title: 'T', baseSeq: 0 }),
    ).toBe('title');
    expect(controller.moveTab(request, 'tab_1', { direction: 'up' })).toBe(
      'moved',
    );
    expect(controller.removeTab(request, 'tab_1')).toBe('removed');
    expect(editor.editBio).toHaveBeenCalledWith('u1', 'b', 2);
    expect(editor.editTabText).toHaveBeenCalledWith('u1', 'tab_1', 't', 3);
    expect(editor.editTabTitle).toHaveBeenCalledWith('u1', 'tab_1', 'T', 0);
    expect(editor.moveTab).toHaveBeenCalledWith('u1', 'tab_1', 'up');
    expect(editor.removeTab).toHaveBeenCalledWith('u1', 'tab_1');
  });

  it('passes the uploaded bytes, or nothing when no file came', () => {
    const buffer = Buffer.from('x');
    expect(controller.replacePicture(request, { buffer })).toBe('picture');
    expect(page.replacePicture).toHaveBeenLastCalledWith('u1', buffer);
    controller.replacePicture(request, undefined);
    expect(page.replacePicture).toHaveBeenLastCalledWith('u1', undefined);
  });
});

describe('MembersController history', () => {
  it('asks with the resolved viewer and passes the query on', async () => {
    const { service, viewer } = members(true);
    const history = {
      bioHistory: jest.fn(() => Promise.resolve('bio-history')),
      tabHistory: jest.fn(() => Promise.resolve('tab-history')),
    };
    const controller = new MembersController(
      service as unknown as MembersService,
      history as unknown as MemberHistoryService,
    );
    await expect(
      controller.bioHistory(request, 'quiet-fern', { page: 2 }),
    ).resolves.toBe('bio-history');
    await expect(
      controller.tabHistory(request, 'quiet-fern', 'tab_1', {
        field: 'title',
        page: 3,
      }),
    ).resolves.toBe('tab-history');
    expect(history.bioHistory).toHaveBeenCalledWith('quiet-fern', viewer, 2);
    expect(history.tabHistory).toHaveBeenCalledWith(
      'quiet-fern',
      'tab_1',
      viewer,
      'title',
      3,
    );
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

describe('cache headers on the member reads', () => {
  const interceptorsOf = (name: keyof MembersController) =>
    (Reflect.getMetadata(
      '__interceptors__',
      Object.getOwnPropertyDescriptor(MembersController.prototype, name)!
        .value as object,
    ) ?? []) as unknown[];

  it.each([
    'directory',
    'chats',
    'profile',
    'bioHistory',
    'tabHistory',
  ] as const)('%s is explicit for guests too', (name) => {
    expect(interceptorsOf(name)).toContain(MemberJsonCacheInterceptor);
  });

  it('the picture route keeps its own caching', () => {
    expect(interceptorsOf('picture')).not.toContain(MemberJsonCacheInterceptor);
  });
});
