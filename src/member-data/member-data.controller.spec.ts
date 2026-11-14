import type { ExecutionContext } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminRoleGuard } from '../auth/admin-role.guard';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { MemberWriteThrottleGuard } from '../members/member-write-throttle.guard';
import {
  AdminDeletedPagesController,
  AdminDeletedPageWritesController,
  EXPORT_ACCOUNT_THROTTLE,
  EXPORT_DAILY_LIMIT_CODE,
  exportFileName,
  ExportThrottleGuard,
  MyDataController,
  MyDataWritesController,
} from './member-data.controller';

const request = { auth: { payload: { sub: 'user_me' } } } as never;

function guardsOf(target: object, method?: string) {
  return (
    (Reflect.getMetadata(
      GUARDS_METADATA,
      method ? (target as Record<string, object>)[method] : target,
    ) as unknown[]) ?? []
  );
}

describe('MyDataController', () => {
  it('serves only the signed-in account: no account id in any route', async () => {
    const deletion = { status: jest.fn(() => Promise.resolve({ page: null })) };
    const exporter = {
      build: jest.fn(() => Promise.resolve({ zip: new Uint8Array([1, 2]) })),
    };
    const viewer = { kind: 'signed-in', userId: 'user_me', isAdmin: true };
    const members = { resolveViewer: jest.fn(() => Promise.resolve(viewer)) };
    const controller = new MyDataController(
      deletion as never,
      exporter as never,
      members as never,
    );
    await controller.status(request);
    expect(deletion.status).toHaveBeenCalledWith('user_me');
    const response = { setHeader: jest.fn(), send: jest.fn() };
    await controller.download(request, response as never);
    expect(exporter.build).toHaveBeenCalledWith(
      'user_me',
      viewer,
      expect.any(Date),
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/zip',
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringMatching(
        /^attachment; filename="org-my-data-\d{4}-\d{2}-\d{2}\.zip"$/,
      ),
    );
    expect(response.send).toHaveBeenCalledWith(Buffer.from([1, 2]));
  });

  it('requires sign-in for every route, and rations the export per account', () => {
    expect(guardsOf(MyDataController)).toEqual([ClerkAuthGuard]);
    expect(guardsOf(MyDataController.prototype, 'download')).toEqual([
      ExportThrottleGuard,
    ]);
    expect(guardsOf(MyDataWritesController)).toEqual([
      ClerkAuthGuard,
      MemberWriteThrottleGuard,
    ]);
  });

  it('names a download by its day only', () => {
    expect(exportFileName(new Date('2026-11-14T23:00:00Z'))).toBe(
      'org-my-data-2026-11-14.zip',
    );
  });
});

describe('ExportThrottleGuard', () => {
  it('allows five exports a day per account, then a 429 with Retry-After', () => {
    const guard = new ExportThrottleGuard();
    const header = jest.fn();
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ header }),
      }),
    } as unknown as ExecutionContext;
    for (let i = 0; i < EXPORT_ACCOUNT_THROTTLE.limit; i += 1) {
      expect(guard.canActivate(context)).toBe(true);
    }
    try {
      guard.canActivate(context);
      throw new Error('not refused');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
      expect((error as HttpException).getResponse()).toMatchObject({
        code: EXPORT_DAILY_LIMIT_CODE,
      });
    }
    expect(header).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });
});

describe('MyDataWritesController', () => {
  it('deletes and undoes the signed-in account’s own page only', async () => {
    const deletion = {
      deleteOwn: jest.fn(() => Promise.resolve({ deleted: true })),
      undoOwn: jest.fn(() => Promise.resolve({ deleted: false })),
    };
    const controller = new MyDataWritesController(deletion as never);
    await controller.deletePage(request, { confirm: 'my-page' });
    expect(deletion.deleteOwn).toHaveBeenCalledWith('user_me', 'my-page');
    await controller.undo(request);
    expect(deletion.undoOwn).toHaveBeenCalledWith('user_me');
  });
});

describe('the admin deleted-pages routes', () => {
  it('are for admins only, and pass the admin and the page through', async () => {
    expect(guardsOf(AdminDeletedPagesController)).toEqual([
      ClerkAuthGuard,
      AdminRoleGuard,
    ]);
    expect(guardsOf(AdminDeletedPageWritesController)).toEqual([
      ClerkAuthGuard,
      AdminRoleGuard,
      MemberWriteThrottleGuard,
    ]);
    const deletion = {
      list: jest.fn(() => Promise.resolve({})),
      adminRestore: jest.fn(() => Promise.resolve({ restored: true })),
    };
    const purge = { due: jest.fn(() => Promise.resolve({})) };
    const reads = new AdminDeletedPagesController(
      deletion as never,
      purge as never,
    );
    await reads.list({});
    await reads.list({ page: 3 });
    expect(deletion.list.mock.calls).toEqual([[1], [3]]);
    await reads.due();
    expect(purge.due).toHaveBeenCalled();
    const writes = new AdminDeletedPageWritesController(deletion as never);
    await writes.restore(request, 'quiet-fern', { reason: 'Asked.' });
    expect(deletion.adminRestore).toHaveBeenCalledWith(
      'user_me',
      'quiet-fern',
      'Asked.',
    );
  });
});
