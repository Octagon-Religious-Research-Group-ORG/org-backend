/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect matchers */
import { Logger } from '@nestjs/common';
import {
  LEASE_MS,
  MAX_ATTEMPTS,
  RETRY_MS,
  TICK_MS,
} from './notification-dispatcher.service';
import { harness, NOW } from './notifications-harness.mocks-spec';

const fresh = () => ({ ...harness(), now: new Date(NOW) });

describe('NotificationDispatcher (Chunk 14)', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
    jest.restoreAllMocks();
  });

  describe('start and stop', () => {
    it('still runs (for the expiry sweep) when sending is not configured, and says so', () => {
      const h = harness({ enabled: false });
      const every = jest
        .spyOn(global, 'setInterval')
        .mockReturnValue({ unref: () => undefined } as never);
      jest.spyOn(h.dispatcher, 'tick').mockResolvedValue();
      h.dispatcher.onApplicationBootstrap();
      expect(every).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not sent'));
      h.dispatcher.onModuleDestroy();
    });

    it('runs once on start (the catch-up after a wake) and then every hour', async () => {
      const h = harness();
      const unref = jest.fn();
      const every = jest
        .spyOn(global, 'setInterval')
        .mockImplementation((fn: () => void) => {
          setImmediate(fn);
          return { unref } as never;
        });
      const clear = jest.spyOn(global, 'clearInterval');
      const tick = jest.spyOn(h.dispatcher, 'tick');
      h.dispatcher.onApplicationBootstrap();
      expect(every).toHaveBeenCalledWith(expect.any(Function), TICK_MS);
      expect(unref).toHaveBeenCalled();
      expect(tick).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(tick).toHaveBeenCalledTimes(2);
      h.dispatcher.onModuleDestroy();
      expect(clear).toHaveBeenCalled();
    });
  });

  describe('passes', () => {
    it('runs one pass at a time; kicks waiting together share one pass', async () => {
      const { dispatcher, directory } = fresh();
      const a = dispatcher.kick();
      const b = dispatcher.kick();
      expect(b).toBe(a);
      await a;
      // A kick after it ran is a new pass.
      await dispatcher.kick();
      expect(directory.holdersOf).not.toHaveBeenCalled();
    });

    it('does nothing when sending was turned off, and survives a failing pass', async () => {
      const h = fresh();
      h.queued({
        userId: 'u1',
        kind: 'claim-approved',
        category: 'claims',
        delivery: 'immediate',
      });
      h.mail.state.enabled = false;
      await h.dispatcher.tick(h.now);
      expect(h.mail.sendNotice).not.toHaveBeenCalled();
      h.mail.state.enabled = true;
      h.mail.noticesEnabled.mockImplementationOnce(() => {
        throw new Error('broken');
      });
      await h.dispatcher.tick(h.now);
      expect(error).toHaveBeenCalledWith('Notification pass failed: broken');
      h.mail.noticesEnabled.mockImplementationOnce(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error on purpose
        throw 'odd';
      });
      await h.dispatcher.tick();
      expect(error).toHaveBeenCalledWith('Notification pass failed: odd');
    });

    it('keeps going after one step fails', async () => {
      const h = fresh();
      h.queued({
        userId: '@admins',
        kind: 'admin-report',
        category: 'adminReports',
        delivery: 'fanout',
      });
      h.directory.holdersOf.mockRejectedValueOnce(new Error('clerk down'));
      jest
        .spyOn(h.digests, 'run')
        .mockRejectedValueOnce(new Error('digest broke'));
      await h.dispatcher.tick(h.now);
      expect(error).toHaveBeenCalledWith(
        'Notification daily digests failed: digest broke',
      );
      jest.spyOn(h.digests, 'run').mockRejectedValueOnce('odd');
      await h.dispatcher.tick(h.now);
      expect(error).toHaveBeenCalledWith(
        'Notification daily digests failed: odd',
      );
    });
  });

  describe('admin fan-out', () => {
    it('copies a notice to every admin but the one it is about and the one who caused it', async () => {
      const h = fresh();
      h.directory.holdersOf.mockResolvedValue({
        holders: [
          { userId: 'user_admin1' },
          { userId: 'user_admin2' },
          { userId: 'user_admin3' },
          { userId: 'user_admin4' },
        ],
        complete: true,
      });
      await h.prefs.update('user_admin3', true, {
        categories: { adminReports: false },
      });
      await h.prefs.update('user_admin4', true, { adminImmediate: false });
      const notice = h.queued({
        userId: '@admins',
        kind: 'admin-report',
        category: 'adminReports',
        delivery: 'fanout',
        subjectUserId: 'user_admin1',
        actorUserId: 'user_admin2',
        refs: { inboxKey: 'page-submitted:p1' },
      });
      await h.dispatcher.kick();
      const copies = h.queue.docs.filter((d) => d.userId !== '@admins');
      // admin1 is the subject, admin2 the reporter, admin3 turned it off.
      expect(copies.map((d) => [d.userId, d.delivery])).toEqual([
        ['user_admin4', 'digest'],
      ]);
      expect(copies[0].dedupeKey).toBe(`fan:${String(notice._id)}:user_admin4`);
      expect(notice.status).toBe('done');
      expect(notice.leaseUntil).toBeUndefined();
      expect(h.inbox.docs[0].emailedAt).toBeInstanceOf(Date);
    });

    it('adds the allowlist’s verified admins, and copies once even when run twice', async () => {
      const h = fresh();
      h.adminAccess.allowlist.mockReturnValue(['listed@example.test']);
      h.directory.usersByEmail.mockResolvedValue([
        {
          holder: { userId: 'user_listed', email: 'listed@example.test' },
          emailVerified: true,
        },
        {
          holder: { userId: 'user_unverified', email: 'listed@example.test' },
          emailVerified: false,
        },
        { holder: { userId: 'user_noemail' }, emailVerified: true },
        {
          holder: { userId: 'user_other', email: 'other@example.test' },
          emailVerified: true,
        },
      ] as never);
      h.directory.holdersOf.mockResolvedValue({
        holders: [{ userId: 'user_admin1' }],
        complete: false,
      });
      const notice = h.queued({
        userId: '@admins',
        kind: 'admin-page-submitted',
        category: 'adminPages',
        delivery: 'fanout',
        subjectUserId: 'user_m',
        actorUserId: 'user_m',
      });
      // A tick that died after copying to admin1.
      h.queued({
        userId: 'user_admin1',
        kind: 'admin-page-submitted',
        category: 'adminPages',
        delivery: 'digest',
        dedupeKey: `fan:${String(notice._id)}:user_admin1`,
      });
      await h.dispatcher.kick();
      expect(
        h.queue.docs.filter((d) => d.userId !== '@admins').map((d) => d.userId),
      ).toEqual(['user_admin1', 'user_listed']);
      // Incomplete: kept, to be tried again (review L9).
      expect(notice).toMatchObject({ status: 'queued', attempts: 1 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('incomplete'));
    });

    it('waits when the admin list cannot be read, and stops on a real failure', async () => {
      const h = fresh();
      h.directory.holdersOf.mockRejectedValueOnce('clerk down');
      const notice = h.queued({
        userId: '@admins',
        kind: 'admin-eam-request',
        category: 'adminEam',
        delivery: 'fanout',
        subjectUserId: 'user_m',
        actorUserId: 'user_m',
      });
      await h.dispatcher.tick(h.now);
      expect(notice.status).toBe('queued');
      expect(notice.nextAttemptAt).toEqual(
        new Date(h.now.getTime() + RETRY_MS),
      );
      // Not due yet: nothing happens.
      await h.dispatcher.tick(h.now);
      expect(h.directory.holdersOf).toHaveBeenCalledTimes(1);
      // A write that fails for another reason stops the step, logged.
      const later = new Date(h.now.getTime() + RETRY_MS);
      const create = jest
        .spyOn(h.queue, 'create')
        .mockRejectedValueOnce(new Error('disk full'));
      await h.dispatcher.tick(later);
      expect(create).toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        'Notification admin fan-out failed: disk full',
      );
      // Still held: the next tick after the lease takes it again.
      expect(notice.status).toBe('queued');
      await h.dispatcher.tick(new Date(later.getTime() + LEASE_MS + 1));
      expect(notice.status).toBe('done');
    });
  });

  describe('immediate emails', () => {
    const immediate = (h: ReturnType<typeof fresh>, extra = {}) =>
      h.queued({
        userId: 'user_c',
        kind: 'claim-approved',
        category: 'claims',
        delivery: 'immediate',
        ...extra,
      });

    it('sends at once, marked sent, with an idempotency key per attempt', async () => {
      const h = fresh();
      const row = immediate(h);
      await h.dispatcher.kick();
      expect(h.mail.sendNotice).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user_c@example.test',
          subject: expect.stringContaining('approved'),
          idempotencyKey: `org-notice-${String(row._id)}-0`,
        }),
      );
      expect(row).toMatchObject({ status: 'sent' });
      expect(row.sentAt).toBeInstanceOf(Date);
      expect(row.leaseToken).toBeUndefined();
      expect(await h.budget.status()).toMatchObject({ sent: 1 });
    });

    it('drops what may no longer be sent, saying why', async () => {
      const h = fresh();
      const admins = immediate(h, { userId: '@admins' });
      const gone = immediate(h, { userId: 'user_gone' });
      const off = immediate(h, { userId: 'user_off' });
      const hidden = immediate(h, { refs: { commentId: 'hidden' } });
      const noEmail = immediate(h, { userId: 'user_noemail' });
      await h.prefs.unsubscribe('user_off', 'claims');
      h.targets.recipient.mockImplementation((userId: string) =>
        Promise.resolve(
          userId === 'user_gone'
            ? undefined
            : {
                userId,
                ...(userId === 'user_noemail'
                  ? {}
                  : { email: `${userId}@example.test` }),
                isAdmin: false,
                viewer: { kind: 'named-member', userId, isAdmin: false },
              },
        ),
      );
      await h.dispatcher.tick(h.now);
      expect(
        [admins, gone, off, hidden, noEmail].map((r) => [r.status, r.outcome]),
      ).toEqual([
        ['skipped', 'not a reader'],
        ['skipped', 'account gone'],
        ['skipped', 'turned off'],
        ['skipped', 'no longer visible'],
        ['skipped', 'no verified address'],
      ]);
      expect(h.mail.sendNotice).not.toHaveBeenCalled();
    });

    it('moves to the digest when immediate emails were turned off since', async () => {
      const h = fresh();
      const row = immediate(h);
      await h.prefs.unsubscribe('user_c', 'immediate');
      await h.dispatcher.kick();
      expect(row).toMatchObject({ status: 'queued', delivery: 'digest' });
      expect(h.mail.sendNotice).not.toHaveBeenCalled();
    });

    it('retries a failed send, then gives up', async () => {
      const h = fresh();
      const row = immediate(h);
      h.mail.sendNotice.mockResolvedValue('refused');
      let at = h.now;
      for (let n = 1; n < MAX_ATTEMPTS; n++) {
        await h.dispatcher.tick(at);
        expect(row).toMatchObject({ status: 'queued', attempts: n });
        expect(row.nextAttemptAt).toEqual(new Date(at.getTime() + RETRY_MS));
        at = new Date(at.getTime() + RETRY_MS);
      }
      await h.dispatcher.tick(at);
      expect(row).toMatchObject({
        status: 'failed',
        attempts: MAX_ATTEMPTS,
        outcome: 'send refused',
      });
      expect(h.mail.sendNotice).toHaveBeenCalledTimes(MAX_ATTEMPTS);
      // Each attempt had its own key, so a real retry is not swallowed.
      expect(
        h.mail.sendNotice.mock.calls.map(
          (call) =>
            (call as unknown as [{ idempotencyKey: string }])[0].idempotencyKey,
        ),
      ).toEqual([0, 1, 2].map((n) => `org-notice-${String(row._id)}-${n}`));
    });

    it('retries when the account cannot be read', async () => {
      const h = fresh();
      const row = immediate(h);
      h.targets.recipient.mockRejectedValueOnce(new Error('clerk down'));
      await h.dispatcher.tick(h.now);
      expect(row).toMatchObject({
        status: 'queued',
        attempts: 1,
        outcome: 'account unavailable',
      });
      h.targets.recipient.mockRejectedValueOnce('odd');
      await h.dispatcher.tick(new Date(h.now.getTime() + RETRY_MS));
      expect(row.attempts).toBe(2);
    });

    it('waits for tomorrow when the day’s budget is spent, and stops the pass', async () => {
      const h = harness({
        config: { EMAIL_DAILY_LIMIT: 1, EMAIL_IMMEDIATE_RESERVE: 0 },
      });
      const first = h.queued({
        userId: 'user_a',
        kind: 'comment-hidden',
        category: 'moderation',
        delivery: 'immediate',
      });
      const second = h.queued({
        userId: 'user_b',
        kind: 'comment-hidden',
        category: 'moderation',
        delivery: 'immediate',
      });
      const third = h.queued({
        userId: 'user_c',
        kind: 'comment-hidden',
        category: 'moderation',
        delivery: 'immediate',
      });
      await h.dispatcher.tick(NOW);
      expect(first.status).toBe('sent');
      expect(second.status).toBe('queued');
      expect(second.nextAttemptAt).toEqual(new Date('2026-11-14T00:00:00Z'));
      // The pass stopped: the third was never even held.
      expect(third.leaseToken).toBeUndefined();
      expect(third.nextAttemptAt).toBeUndefined();
    });
  });

  it('reports the state of email for the admin dashboard', async () => {
    const h = fresh();
    h.queued({
      userId: 'u',
      kind: 'reply',
      category: 'replies',
      delivery: 'digest',
    });
    h.queued({
      userId: 'u',
      kind: 'claim-approved',
      category: 'claims',
      delivery: 'immediate',
    });
    h.queued({
      userId: '@admins',
      kind: 'admin-report',
      category: 'adminReports',
      delivery: 'fanout',
    });
    h.queued({
      userId: 'u',
      kind: 'reply',
      category: 'replies',
      delivery: 'digest',
      status: 'failed',
      updatedAt: h.now,
    });
    await h.budget.take('digest', h.now);
    expect(await h.dispatcher.status(h.now)).toEqual({
      enabled: true,
      digestHourUtc: 14,
      budget: {
        day: '2026-11-13',
        sent: 1,
        dailyLimit: 10,
        immediateReserve: 3,
      },
      waiting: { digest: 1, immediate: 1, adminNotices: 1 },
      failedLast7Days: 1,
      digestFailedLast7Days: 0,
    });
    expect((await h.dispatcher.status()).budget.day).toMatch(/^\d{4}-/);
  });
});
