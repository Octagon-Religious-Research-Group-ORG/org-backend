// Chunk 14 review fixes, each written to fail on the reviewed code first
// (c5fe8aa). Synthetic data only; no email is sent.
import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { DIGEST_MAX_ATTEMPTS } from './digest-sender';
import {
  EXPIRY_MARGIN_MS,
  MAX_FANOUT_ATTEMPTS,
  RETRY_MS,
} from './notification-dispatcher.service';
import { readNotificationConfig } from './notification-config';
import {
  harness,
  harnessConfig,
  NOW,
  recipientOf,
} from './notifications-harness.mocks-spec';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const keysOf = (h: ReturnType<typeof harness>) =>
  h.mail.sendNotice.mock.calls.map(
    (call) =>
      (call as unknown as [{ idempotencyKey: string }])[0].idempotencyKey,
  );

describe('Chunk 14 review fixes', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('M1: a queued row that would expire unsent', () => {
    it('ends as failed, counted, instead of vanishing', async () => {
      const h = harness();
      const row = h.queued({
        userId: 'user_a',
        kind: 'reply',
        category: 'replies',
        delivery: 'digest',
        expiresAt: new Date(NOW.getTime() + EXPIRY_MARGIN_MS - 1),
      });
      await h.dispatcher.tick(NOW);
      expect(row).toMatchObject({
        status: 'failed',
        outcome: 'expired unsent',
      });
      // Kept long enough to be counted on the dashboard.
      expect((row.expiresAt as Date).getTime()).toBeGreaterThan(
        NOW.getTime() + 6 * DAY,
      );
    });
  });

  describe('L1: a digest that died across UTC midnight', () => {
    it('is resumed the next day with its same items and key, not sent anew', async () => {
      const h = harness();
      const item = h.queued({
        userId: 'user_a',
        kind: 'reply',
        category: 'replies',
        delivery: 'digest',
        createdAt: new Date(NOW.getTime() - DAY),
      });
      const rowId = new Types.ObjectId();
      h.digestRows.docs.push({
        _id: rowId,
        userId: 'user_a',
        day: '2026-11-12',
        status: 'sending',
        itemIds: [item._id],
        attempts: 0,
        keyGen: 0,
        leaseUntil: new Date(NOW.getTime() - HOUR),
        leaseToken: 'dead',
      });
      expect(await h.digests.forMember('user_a', NOW)).toBe('sent');
      expect(keysOf(h)).toEqual([`org-digest-${String(rowId)}-0`]);
      expect(h.digestRows.docs).toHaveLength(1);
      expect(h.digestRows.docs[0]).toMatchObject({
        day: '2026-11-13',
        status: 'sent',
      });
      expect(item.status).toBe('sent');
    });
  });

  describe('L2: an ambiguous send keeps its key; only a refusal gets a new one', () => {
    it('immediate emails', async () => {
      const h = harness();
      const row = h.queued({
        userId: 'user_c',
        kind: 'claim-approved',
        category: 'claims',
        delivery: 'immediate',
      });
      h.mail.sendNotice
        .mockResolvedValueOnce('unknown')
        .mockResolvedValueOnce('refused')
        .mockResolvedValueOnce('sent');
      await h.dispatcher.tick(NOW);
      await h.dispatcher.tick(new Date(NOW.getTime() + RETRY_MS));
      await h.dispatcher.tick(new Date(NOW.getTime() + 2 * RETRY_MS));
      const id = String(row._id);
      expect(keysOf(h)).toEqual([
        `org-notice-${id}-0`,
        `org-notice-${id}-0`,
        `org-notice-${id}-1`,
      ]);
      expect(row.status).toBe('sent');
    });

    it('digests', async () => {
      const h = harness();
      h.queued({
        userId: 'user_a',
        kind: 'reply',
        category: 'replies',
        delivery: 'digest',
      });
      h.mail.sendNotice
        .mockResolvedValueOnce('unknown')
        .mockResolvedValueOnce('refused')
        .mockResolvedValueOnce('sent');
      for (let n = 0; n < 3; n++) await h.digests.forMember('user_a', NOW);
      const id = String(h.digestRows.docs[0]._id);
      expect(keysOf(h)).toEqual([
        `org-digest-${id}-0`,
        `org-digest-${id}-0`,
        `org-digest-${id}-1`,
      ]);
    });

    it('never resends an ambiguous email once its key may have expired', async () => {
      const h = harness();
      const row = h.queued({
        userId: 'user_c',
        kind: 'claim-approved',
        category: 'claims',
        delivery: 'immediate',
      });
      h.mail.sendNotice.mockResolvedValueOnce('unknown');
      await h.dispatcher.tick(NOW);
      await h.dispatcher.tick(new Date(NOW.getTime() + 24 * HOUR));
      expect(h.mail.sendNotice).toHaveBeenCalledTimes(1);
      expect(row).toMatchObject({
        status: 'failed',
        outcome: 'outcome unknown; not resent',
      });
    });
  });

  describe('L3: a takeover replays the body that was sent under the key', () => {
    it('does not rebuild it', async () => {
      const h = harness();
      const item = h.queued({
        userId: 'user_a',
        kind: 'reply',
        category: 'replies',
        delivery: 'digest',
      });
      h.digestRows.docs.push({
        _id: new Types.ObjectId(),
        userId: 'user_a',
        day: '2026-11-13',
        status: 'sending',
        itemIds: [item._id],
        shownIds: [item._id],
        email: {
          subject: 'Stored subject',
          lines: ['Stored line'],
          headers: { 'List-Unsubscribe': '<https://org.example.test/u>' },
        },
        attempts: 0,
        keyGen: 0,
        leaseUntil: new Date(NOW.getTime() - 1),
        leaseToken: 'dead',
      });
      expect(await h.digests.forMember('user_a', NOW)).toBe('sent');
      expect(h.targets.describe).not.toHaveBeenCalled();
      expect(h.mail.sendNotice).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Stored subject',
          lines: ['Stored line'],
        }),
      );
      expect(item.status).toBe('sent');
    });

    it('stores the body before the first send, links only', async () => {
      const h = harness();
      h.queued({
        userId: 'user_a',
        kind: 'reply',
        category: 'replies',
        delivery: 'digest',
      });
      h.mail.sendNotice.mockResolvedValueOnce('unknown');
      await h.digests.forMember('user_a', NOW);
      const stored = h.digestRows.docs[0].email as { lines: string[] };
      expect(stored.lines.join('\n')).toContain(
        'https://org.example.test/page',
      );
    });
  });

  describe('L4: members who will be skipped do not hold up the rest', () => {
    it('reaches a normal member behind a full page of them', async () => {
      const h = harness();
      h.digests.membersPerPass = 3;
      for (let n = 0; n < 5; n++) {
        const userId = `user_done${n}`;
        h.digestRows.docs.push({
          userId,
          day: '2026-11-13',
          status: 'sent',
          itemIds: [],
          attempts: 0,
        });
        h.queued({
          userId,
          kind: 'reply',
          category: 'replies',
          delivery: 'digest',
          createdAt: new Date(NOW.getTime() - 3 * HOUR),
        });
      }
      const normal = h.queued({
        userId: 'user_normal',
        kind: 'reply',
        category: 'replies',
        delivery: 'digest',
        createdAt: new Date(NOW.getTime() - HOUR),
      });
      await h.digests.run(NOW);
      expect(normal.status).toBe('sent');
      // The others' news waits for tomorrow, out of today's way.
      const later = h.queue.docs.find((d) => d.userId === 'user_done0')!;
      expect(later.nextAttemptAt).toEqual(new Date('2026-11-14T00:00:00Z'));
    });

    it('moves the news of a member whose digest finally failed to the next day', async () => {
      const h = harness();
      const item = h.queued({
        userId: 'user_a',
        kind: 'reply',
        category: 'replies',
        delivery: 'digest',
      });
      h.mail.sendNotice.mockResolvedValue('refused');
      for (let n = 0; n < DIGEST_MAX_ATTEMPTS; n++) {
        await h.digests.forMember('user_a', NOW);
      }
      expect(item.status).toBe('queued');
      expect(item.nextAttemptAt).toEqual(new Date('2026-11-14T00:00:00Z'));
    });

    it('marks the news of a digest whose last send was ambiguous failed, never resent', async () => {
      const h = harness();
      const item = h.queued({
        userId: 'user_a',
        kind: 'reply',
        category: 'replies',
        delivery: 'digest',
      });
      h.mail.sendNotice.mockResolvedValue('unknown');
      for (let n = 0; n < DIGEST_MAX_ATTEMPTS; n++) {
        await h.digests.forMember('user_a', NOW);
      }
      expect(item).toMatchObject({
        status: 'failed',
        outcome: 'outcome unknown; not resent',
      });
    });
  });

  describe('L7: failed digests reach the dashboard', () => {
    it('counts them', async () => {
      const h = harness();
      h.digestRows.docs.push({
        userId: 'user_a',
        day: '2026-11-13',
        status: 'failed',
        attempts: DIGEST_MAX_ATTEMPTS,
        updatedAt: NOW,
      });
      h.digestRows.docs.push({
        userId: 'user_b',
        day: '2026-11-13',
        status: 'failed',
        attempts: 1,
        updatedAt: NOW,
      });
      expect((await h.dispatcher.status(NOW)).digestFailedLast7Days).toBe(1);
    });
  });

  describe('L8: claim and moderation news that fell back to the digest', () => {
    it('goes at once when the member later turns the digest off and immediate on', async () => {
      const h = harness();
      const item = h.queued({
        userId: 'user_a',
        kind: 'claim-approved',
        category: 'claims',
        delivery: 'digest',
      });
      await h.prefs.update('user_a', false, {
        digest: false,
        immediate: true,
      });
      await h.digests.forMember('user_a', NOW);
      expect(item).toMatchObject({ status: 'queued', delivery: 'immediate' });
      await h.dispatcher.kick();
      expect(item.status).toBe('sent');
    });
  });

  describe('L9: an incomplete admin list', () => {
    it('tells the admins it has, keeps the notice, and gives up only after a bound', async () => {
      const h = harness();
      h.directory.holdersOf.mockResolvedValue({
        holders: [{ userId: 'user_admin1' }],
        complete: false,
      });
      const notice = h.queued({
        userId: '@admins',
        kind: 'admin-report',
        category: 'adminReports',
        delivery: 'fanout',
        subjectUserId: 'user_m',
        actorUserId: 'user_r',
      });
      let at = NOW;
      await h.dispatcher.tick(at);
      expect(notice.status).toBe('queued');
      expect(notice.nextAttemptAt).toEqual(new Date(at.getTime() + RETRY_MS));
      for (let n = 1; n < MAX_FANOUT_ATTEMPTS; n++) {
        at = new Date(at.getTime() + RETRY_MS);
        await h.dispatcher.tick(at);
      }
      expect(notice).toMatchObject({
        status: 'done',
        outcome: 'admin list incomplete',
      });
      // admin1 was told once, however many retries.
      expect(
        h.queue.docs.filter((d) => d.userId === 'user_admin1'),
      ).toHaveLength(1);
    });
  });

  describe('L10: order emails count against the same day', () => {
    it('is counted, never refused, and digests yield to it', async () => {
      const h = harness({
        config: { EMAIL_DAILY_LIMIT: 3, EMAIL_IMMEDIATE_RESERVE: 1 },
      });
      await h.budget.record(2, NOW);
      await h.budget.record(5, NOW);
      expect((await h.budget.status(NOW)).sent).toBe(7);
      expect(await h.budget.take('digest', NOW)).toBe(false);
      expect(await h.budget.take('immediate', NOW)).toBe(false);
    });
  });

  describe('L11: PUBLIC_API_URL in any reasonable form', () => {
    it('normalises a trailing slash and /api/v1, and drops a bad one with a reason', () => {
      const read = (value: string) =>
        readNotificationConfig(harnessConfig({ PUBLIC_API_URL: value }));
      for (const value of [
        'https://api.example.test',
        'https://api.example.test/',
        'https://api.example.test/api/v1',
        'https://api.example.test/api/v1/',
      ]) {
        expect(read(value).publicApiUrl).toBe('https://api.example.test');
      }
      const bad = read('not a url');
      expect(bad.publicApiUrl).toBeUndefined();
      expect(bad.publicApiUrlProblem).toMatch(/not a web address/);
      expect(read('ftp://api.example.test').publicApiUrl).toBeUndefined();
    });

    it('warns at start-up about a bad one', () => {
      const h = harness({ config: { PUBLIC_API_URL: 'not a url' } });
      jest.spyOn(global, 'setInterval').mockReturnValue({
        unref: () => undefined,
      } as never);
      jest.spyOn(h.dispatcher, 'tick').mockResolvedValue();
      h.dispatcher.onApplicationBootstrap();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('PUBLIC_API_URL'),
      );
    });
  });
  describe('coverage of the new paths', () => {
    it('gives up on a digest whose ambiguous send may have outlived its key', async () => {
      for (const shown of [true, false]) {
        const h = harness();
        const item = h.queued({
          userId: 'user_a',
          kind: 'reply',
          category: 'replies',
          delivery: 'digest',
        });
        h.digestRows.docs.push({
          userId: 'user_a',
          day: '2026-11-12',
          status: 'failed',
          itemIds: [item._id],
          ...(shown ? { shownIds: [item._id] } : {}),
          attempts: 1,
          keyGen: 0,
          unknownSince: new Date(NOW.getTime() - 24 * HOUR),
        });
        expect(await h.digests.forMember('user_a', NOW)).toBe('failed');
        expect(item).toMatchObject({
          status: 'failed',
          outcome: 'outcome unknown; not resent',
        });
        expect(h.mail.sendNotice).not.toHaveBeenCalled();
      }
    });

    it('moves a digest on after the account could not be read three times', async () => {
      const h = harness();
      const item = h.queued({
        userId: 'user_a',
        kind: 'reply',
        category: 'replies',
        delivery: 'digest',
      });
      h.targets.recipient.mockRejectedValue(new Error('clerk down'));
      for (let n = 0; n < DIGEST_MAX_ATTEMPTS; n++) {
        await h.digests.forMember('user_a', NOW);
      }
      expect(item.nextAttemptAt).toEqual(new Date('2026-11-14T00:00:00Z'));
    });

    it('leaves a resumed row alone when today already has one, and passes other failures on', async () => {
      const h = harness();
      jest
        .spyOn(h.digestRows, 'findOneAndUpdate')
        .mockImplementationOnce(() => {
          throw Object.assign(new Error('dup'), { code: 11000 });
        })
        .mockImplementationOnce(() => {
          throw new Error('disk full');
        });
      expect(await h.digests.forMember('user_a', NOW)).toBe('skipped');
      await expect(h.digests.forMember('user_a', NOW)).rejects.toThrow(
        'disk full',
      );
    });

    it('gives up on an immediate email after three unreadable accounts or three ambiguous sends', async () => {
      const h = harness();
      const unreadable = h.queued({
        userId: 'user_x',
        kind: 'claim-approved',
        category: 'claims',
        delivery: 'immediate',
      });
      h.targets.recipient.mockImplementation((userId: string) =>
        userId === 'user_x'
          ? Promise.reject(new Error('clerk down'))
          : Promise.resolve(recipientOf(userId)),
      );
      const ambiguous = h.queued({
        userId: 'user_y',
        kind: 'claim-approved',
        category: 'claims',
        delivery: 'immediate',
      });
      h.mail.sendNotice.mockResolvedValue('unknown');
      let at = NOW;
      for (let n = 0; n < 3; n++) {
        await h.dispatcher.tick(at);
        at = new Date(at.getTime() + RETRY_MS);
      }
      expect(unreadable).toMatchObject({
        status: 'failed',
        outcome: 'account unavailable',
      });
      expect(ambiguous).toMatchObject({
        status: 'failed',
        outcome: 'outcome unknown; not resent',
      });
    });

    it('counts order emails for today when no time is given', async () => {
      const h = harness();
      await h.budget.record(1);
      expect((await h.budget.status()).sent).toBe(1);
    });
  });
});
