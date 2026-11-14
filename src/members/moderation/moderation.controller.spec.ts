import { NotFoundException } from '@nestjs/common';
import {
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
} from '@nestjs/common/constants';
import { AdminRoleGuard } from '../../auth/admin-role.guard';
import { ClerkAuthGuard } from '../../auth/auth.guard';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { MemberWriteThrottleGuard } from '../member-write-throttle.guard';
import { ModerationThrottleGuard } from './moderation-throttle.guard';
import { NoStoreWhenSignedInInterceptor } from '../no-store.interceptor';
import {
  AdminModerationController,
  AdminModerationWritesController,
  MyReportWritesController,
} from './moderation.controller';

const ADMIN = 'user_admin';
const request = (sub: string) =>
  ({
    auth: { payload: { sub } },
    headers: {},
  }) as unknown as AuthenticatedRequest;

function setup() {
  const queue = {
    queue: jest.fn(() => Promise.resolve('queue')),
    moderateComment: jest.fn(() => Promise.resolve('done')),
    dismiss: jest.fn(() => Promise.resolve('dismissed')),
  };
  const writer = { kind: 'named-member', userId: 'user_m', isAdmin: false };
  const writers = { requireWriter: jest.fn(() => Promise.resolve(writer)) };
  const reports = { report: jest.fn(() => Promise.resolve('reported')) };
  return {
    queue,
    writer,
    writers,
    reports,
    mine: new MyReportWritesController(writers as never, reports as never),
    reads: new AdminModerationController(queue as never),
    writes: new AdminModerationWritesController(queue as never),
  };
}

describe('moderation controllers (Chunk 13)', () => {
  it('guards: admins only for the queue, rationed writes, never cached', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AdminModerationController),
    ).toEqual([ClerkAuthGuard, AdminRoleGuard]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AdminModerationWritesController),
    ).toEqual([ClerkAuthGuard, AdminRoleGuard, ModerationThrottleGuard]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, MyReportWritesController),
    ).toEqual([ClerkAuthGuard, MemberWriteThrottleGuard]);
    for (const controller of [
      AdminModerationController,
      AdminModerationWritesController,
      MyReportWritesController,
    ]) {
      expect(Reflect.getMetadata(INTERCEPTORS_METADATA, controller)).toEqual([
        NoStoreWhenSignedInInterceptor,
      ]);
    }
  });

  it('reads the queue with defaults', async () => {
    const { queue, reads } = setup();
    await expect(reads.list(request(ADMIN), {})).resolves.toBe('queue');
    expect(queue.queue).toHaveBeenCalledWith(ADMIN, 'open', 1);
    await reads.list(request(ADMIN), { status: 'resolved', page: 3 });
    expect(queue.queue).toHaveBeenLastCalledWith(ADMIN, 'resolved', 3);
  });

  it('passes each action with its reason, and 404s a malformed id', async () => {
    const { queue, writes } = setup();
    const body = { reason: 'Synthetic' };
    await expect(writes.hide(request(ADMIN), 'cmt_1', body)).resolves.toBe(
      'done',
    );
    await writes.remove(request(ADMIN), 'cmt_1', body);
    await writes.restore(request(ADMIN), 'cmt_1', body);
    expect(queue.moderateComment.mock.calls).toEqual([
      [ADMIN, 'cmt_1', 'hide', 'Synthetic'],
      [ADMIN, 'cmt_1', 'remove', 'Synthetic'],
      [ADMIN, 'cmt_1', 'restore', 'Synthetic'],
    ]);
    expect(() => writes.hide(request(ADMIN), 'bad id!', body)).toThrow(
      NotFoundException,
    );
  });

  it('dismisses only a well-formed target', async () => {
    const { queue, writes } = setup();
    const body = { reason: 'Synthetic' };
    const page = '0123456789abcdef01234567';
    await expect(
      writes.dismiss(request(ADMIN), 'member-page', page, body),
    ).resolves.toBe('dismissed');
    await writes.dismiss(request(ADMIN), 'comment', 'cmt_1', body);
    expect(queue.dismiss.mock.calls).toEqual([
      [ADMIN, 'member-page', page, 'Synthetic'],
      [ADMIN, 'comment', 'cmt_1', 'Synthetic'],
    ]);
    for (const [type, id] of [
      ['member-page', 'cmt_1'],
      ['comment', 'bad id!'],
      ['claim', page],
    ]) {
      expect(() => writes.dismiss(request(ADMIN), type, id, body)).toThrow(
        NotFoundException,
      );
    }
  });

  it('reports as a writer, passing only the fields given', async () => {
    const { writers, reports, writer, mine } = setup();
    const req = request('user_m');
    await expect(
      mine.report(req, {
        targetType: 'comment',
        commentId: 'cmt_1',
        reason: 'spam',
      }),
    ).resolves.toBe('reported');
    expect(writers.requireWriter).toHaveBeenCalledWith(req);
    expect(reports.report).toHaveBeenCalledWith(writer, {
      targetType: 'comment',
      commentId: 'cmt_1',
      reason: 'spam',
    });
    await mine.report(req, {
      targetType: 'member-page',
      slug: 'some-page',
      reason: 'other',
      note: 'Synthetic.',
    });
    expect(reports.report).toHaveBeenLastCalledWith(writer, {
      targetType: 'member-page',
      slug: 'some-page',
      reason: 'other',
      note: 'Synthetic.',
    });
  });
});
