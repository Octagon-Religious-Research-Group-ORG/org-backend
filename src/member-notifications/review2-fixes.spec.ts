// Chunk 14 review round 2 fixes (N1-N6, N8), each written to fail on the
// round-1 code first (c532eee). Synthetic data only; no email is sent.
import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { composeEmail } from './notification-mail';
import { readNotificationConfig } from './notification-config';
import { NotificationPrefsService } from './notification-prefs.service';
import {
  harness,
  harnessConfig,
  NOW,
} from './notifications-harness.mocks-spec';

const HOUR = 60 * 60_000;
const TOMORROW = new Date('2026-11-14T15:00:00Z');
const WITHDRAWN = 'withdrawn after unknown send';
const GIVE_UP = 'outcome unknown; not resent';
const settings = readNotificationConfig(harnessConfig());

/** The email the harness would build for one item. */
const builtFor = (kind: string, scope: string, digest: boolean) =>
  composeEmail({
    items: [{ kind: kind as never, path: '/page' }],
    digest,
    userId: 'user_a',
    scope: scope as never,
    signingKey: settings.signingKey,
    publicAppUrl: settings.publicAppUrl,
  });

const reply = (h: ReturnType<typeof harness>, extra = {}) =>
  h.queued({
    userId: 'user_a',
    kind: 'reply',
    category: 'replies',
    delivery: 'digest',
    ...extra,
  });

describe('Chunk 14 review round 2', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('N1: a digest held back by the budget is built again', () => {
    const deferred = async (h: ReturnType<typeof harness>) => {
      await h.budget.record(7, NOW); // the day's digest share is used up
      expect(await h.digests.forMember('user_a', NOW)).toBe('budget');
    };

    it('an unsubscribe in between wins', async () => {
      const h = harness();
      const item = reply(h);
      await deferred(h);
      await h.prefs.unsubscribe('user_a', 'replies');
      await h.digests.forMember('user_a', TOMORROW);
      expect(h.mail.sendNotice).not.toHaveBeenCalled();
      expect(item).toMatchObject({ status: 'skipped', outcome: 'turned off' });
    });

    it('a change of visibility or admin status in between wins', async () => {
      const h = harness();
      const item = reply(h);
      const notice = h.queued({
        userId: 'user_a',
        kind: 'admin-page-submitted',
        category: 'adminPages',
        delivery: 'digest',
      });
      await deferred(h);
      item.refs = { commentId: 'hidden' };
      // No longer an admin: the admin notice is not allowed any more.
      h.targets.describe.mockImplementation(
        (row: { kind: string; refs?: { commentId?: string } }) =>
          Promise.resolve(
            row.kind.startsWith('admin-') || row.refs?.commentId === 'hidden'
              ? undefined
              : { kind: row.kind, path: '/page' },
          ),
      );
      await h.digests.forMember('user_a', TOMORROW);
      expect(h.mail.sendNotice).not.toHaveBeenCalled();
      expect(item.status).toBe('skipped');
      expect(notice.status).toBe('skipped');
    });
    it('keeps the stored body of a send that may have happened when the budget holds it back', async () => {
      const h = harness();
      const item = reply(h);
      const stored = builtFor('reply', 'digest', true);
      h.digestRows.docs.push({
        userId: 'user_a',
        day: '2026-11-13',
        status: 'failed',
        itemIds: [item._id],
        shownIds: [item._id],
        email: stored,
        keyStartedAt: new Date(NOW.getTime() - HOUR),
        attempts: 1,
        keyGen: 0,
      });
      await h.budget.record(7, NOW);
      expect(await h.digests.forMember('user_a', NOW)).toBe('budget');
      expect(h.digestRows.docs[0]).toMatchObject({
        status: 'deferred',
        email: stored,
      });
    });
  });

  describe('N2: a row still being sent elsewhere', () => {
    it('keeps the member out of this pass, across midnight', async () => {
      const h = harness();
      const item = reply(h);
      h.digestRows.docs.push({
        userId: 'user_a',
        day: '2026-11-13',
        status: 'sending',
        itemIds: [item._id],
        attempts: 0,
        keyGen: 0,
        leaseUntil: new Date(TOMORROW.getTime() + 5 * 60_000),
        leaseToken: 'alive',
      });
      expect(await h.digests.forMember('user_a', TOMORROW)).toBe('skipped');
      expect(h.digestRows.docs).toHaveLength(1);
      expect(h.mail.sendNotice).not.toHaveBeenCalled();
    });

    it('never puts an item another unfinished row holds in a new row', async () => {
      const h = harness();
      const held = reply(h);
      const free = reply(h);
      h.digestRows.docs.push({
        userId: 'user_a',
        day: '2026-11-12',
        status: 'deferred',
        itemIds: [held._id],
        attempts: 0,
      });
      // The unfinished row is taken by another instance just as this one
      // looks (its resume finds nothing).
      jest.spyOn(h.digestRows, 'findOneAndUpdate').mockReturnValueOnce({
        lean: () => ({ exec: () => Promise.resolve(null) }),
      } as never);
      await h.digests.forMember('user_a', NOW);
      const fresh = h.digestRows.docs.find((d) => d.day === '2026-11-13');
      expect((fresh?.itemIds as Types.ObjectId[]).map(String)).toEqual([
        String(free._id),
      ]);
    });
  });

  describe('N3: the 23-hour cutoff counts from when the send started', () => {
    it('immediate: a crash after storing the body, before any result', async () => {
      const h = harness();
      const row = h.queued({
        userId: 'user_c',
        kind: 'claim-approved',
        category: 'claims',
        delivery: 'immediate',
        email: builtFor('claim-approved', 'claims', false),
        keyStartedAt: new Date(NOW.getTime() - 24 * HOUR),
        leaseUntil: new Date(NOW.getTime() - HOUR),
        leaseToken: 'dead',
      });
      await h.dispatcher.tick(NOW);
      expect(h.mail.sendNotice).not.toHaveBeenCalled();
      expect(row).toMatchObject({ status: 'failed', outcome: GIVE_UP });
    });

    it('digest: the same', async () => {
      const h = harness();
      const item = reply(h);
      h.digestRows.docs.push({
        userId: 'user_a',
        day: '2026-11-12',
        status: 'sending',
        itemIds: [item._id],
        shownIds: [item._id],
        email: builtFor('reply', 'digest', true),
        keyStartedAt: new Date(NOW.getTime() - 24 * HOUR),
        attempts: 0,
        keyGen: 0,
        leaseUntil: new Date(NOW.getTime() - HOUR),
      });
      expect(await h.digests.forMember('user_a', NOW)).toBe('failed');
      expect(h.mail.sendNotice).not.toHaveBeenCalled();
      expect(item).toMatchObject({ status: 'failed', outcome: GIVE_UP });
    });

    it('records the start before the send', async () => {
      const h = harness();
      const row = h.queued({
        userId: 'user_c',
        kind: 'claim-approved',
        category: 'claims',
        delivery: 'immediate',
      });
      let seen: unknown;
      h.mail.sendNotice.mockImplementationOnce(() => {
        seen = row.keyStartedAt;
        return Promise.resolve('unknown');
      });
      await h.dispatcher.tick(NOW);
      expect(seen).toEqual(NOW);
    });
  });

  describe('N4: the expiry sweep and leases', () => {
    it('leaves a row a tick holds, and an item an unfinished digest holds', async () => {
      const h = harness();
      // Before the digest hour, so no digest goes out in this pass.
      const morning = new Date('2026-11-13T09:00:00Z');
      const soon = new Date(morning.getTime() + HOUR);
      const leased = h.queued({
        userId: 'user_c',
        kind: 'claim-approved',
        category: 'claims',
        delivery: 'immediate',
        expiresAt: soon,
        leaseUntil: new Date(morning.getTime() + 5 * 60_000),
        leaseToken: 'busy',
      });
      const held = reply(h, { expiresAt: soon });
      const loose = reply(h, { expiresAt: soon });
      h.digestRows.docs.push({
        userId: 'user_a',
        day: '2026-11-13',
        status: 'deferred',
        itemIds: [held._id],
        attempts: 0,
      });
      await h.dispatcher.tick(morning);
      expect(leased.status).toBe('queued');
      expect(held.status).toBe('queued');
      expect(loose).toMatchObject({
        status: 'failed',
        outcome: 'expired unsent',
      });
    });

    it('puts a row back to queued after an ambiguous send, whatever happened meanwhile', async () => {
      const h = harness();
      const row = h.queued({
        userId: 'user_c',
        kind: 'claim-approved',
        category: 'claims',
        delivery: 'immediate',
      });
      h.mail.sendNotice.mockImplementationOnce(() => {
        row.status = 'failed'; // swept while sending
        return Promise.resolve('unknown');
      });
      await h.dispatcher.tick(NOW);
      expect(row).toMatchObject({ status: 'queued', attempts: 1 });
    });
  });

  describe('N5: the sweep at boot', () => {
    it('runs even when sending is off, three days ahead', async () => {
      const h = harness({ enabled: false });
      const row = reply(h, {
        expiresAt: new Date(Date.now() + 2 * 24 * HOUR),
      });
      jest.spyOn(global, 'setInterval').mockReturnValue({
        unref: () => undefined,
      } as never);
      h.dispatcher.onApplicationBootstrap();
      await h.dispatcher.tick();
      expect(row).toMatchObject({
        status: 'failed',
        outcome: 'expired unsent',
      });
    });
  });

  describe('N6: a replay under the same key is checked first', () => {
    it('immediate: withdrawn when the item is no longer allowed', async () => {
      const h = harness();
      const row = h.queued({
        userId: 'user_c',
        kind: 'claim-approved',
        category: 'claims',
        delivery: 'immediate',
        refs: { commentId: 'hidden' },
        attempts: 1,
        email: builtFor('claim-approved', 'claims', false),
        keyStartedAt: new Date(NOW.getTime() - HOUR),
      });
      await h.dispatcher.tick(NOW);
      expect(h.mail.sendNotice).not.toHaveBeenCalled();
      expect(row).toMatchObject({ status: 'failed', outcome: WITHDRAWN });
    });

    it('immediate: withdrawn when the member turned it off', async () => {
      const h = harness();
      const row = h.queued({
        userId: 'user_a',
        kind: 'claim-approved',
        category: 'claims',
        delivery: 'immediate',
        attempts: 1,
        email: builtFor('claim-approved', 'claims', false),
        keyStartedAt: new Date(NOW.getTime() - HOUR),
      });
      await h.prefs.unsubscribe('user_a', 'claims');
      await h.dispatcher.tick(NOW);
      expect(h.mail.sendNotice).not.toHaveBeenCalled();
      expect(row).toMatchObject({ status: 'failed', outcome: WITHDRAWN });
    });

    it('immediate: replayed byte for byte when still allowed', async () => {
      const h = harness();
      const stored = builtFor('claim-approved', 'claims', false);
      const row = h.queued({
        userId: 'user_a',
        kind: 'claim-approved',
        category: 'claims',
        delivery: 'immediate',
        attempts: 1,
        email: stored,
        keyStartedAt: new Date(NOW.getTime() - HOUR),
      });
      await h.dispatcher.tick(NOW);
      expect(h.mail.sendNotice).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: stored.subject,
          lines: stored.lines,
          headers: stored.headers,
          idempotencyKey: `org-notice-${String(row._id)}-0`,
        }),
      );
    });

    it('digest: a takeover is withdrawn when the member turned the category off', async () => {
      const h = harness();
      const item = reply(h);
      h.digestRows.docs.push({
        userId: 'user_a',
        day: '2026-11-13',
        status: 'failed',
        itemIds: [item._id],
        shownIds: [item._id],
        email: builtFor('reply', 'digest', true),
        keyStartedAt: new Date(NOW.getTime() - HOUR),
        attempts: 1,
        keyGen: 0,
      });
      await h.prefs.unsubscribe('user_a', 'replies');
      expect(await h.digests.forMember('user_a', NOW)).toBe('failed');
      expect(h.mail.sendNotice).not.toHaveBeenCalled();
      expect(item).toMatchObject({ status: 'failed', outcome: WITHDRAWN });
      expect(h.digestRows.docs[0]).toMatchObject({ outcome: WITHDRAWN });
      expect(
        (await h.dispatcher.status(NOW)).digestFailedLast7Days,
      ).toBeGreaterThanOrEqual(0);
    });
    it('digest: a takeover is withdrawn when the account is gone', async () => {
      const h = harness();
      const item = reply(h);
      h.digestRows.docs.push({
        userId: 'user_a',
        day: '2026-11-13',
        status: 'failed',
        itemIds: [item._id],
        shownIds: [item._id],
        email: builtFor('reply', 'digest', true),
        keyStartedAt: new Date(NOW.getTime() - HOUR),
        attempts: 1,
        keyGen: 0,
      });
      h.targets.recipient.mockResolvedValueOnce(undefined);
      expect(await h.digests.forMember('user_a', NOW)).toBe('failed');
      expect(h.mail.sendNotice).not.toHaveBeenCalled();
      expect(item).toMatchObject({ status: 'failed', outcome: WITHDRAWN });
    });
  });

  describe('N8: a settings save is one write', () => {
    it('writes once, and never leaves half a change', async () => {
      let writes = 0;
      const model = fakeModel(
        [{ userId: 'user_a', off: ['votes'], digest: true }],
        {
          unique: [['userId']],
          beforeWrite: () => {
            writes += 1;
            if (writes === 2) throw new Error('lost the connection');
          },
        },
      );
      const service = new NotificationPrefsService(model as never);
      const outcome = await service
        .update('user_a', false, {
          categories: { replies: false, votes: true },
          digest: false,
          immediate: false,
        })
        .then(() => 'saved')
        .catch(() => 'refused');
      const now = await service.get('user_a');
      const whole = {
        off: ['replies'],
        digest: false,
        immediate: false,
      };
      const untouched = { off: ['votes'], digest: true, immediate: true };
      expect(outcome === 'saved' ? whole : untouched).toMatchObject({
        off: now.off,
        digest: now.digest,
        immediate: now.immediate,
      });
      expect(writes).toBe(1);
    });
  });
});

void Types;
