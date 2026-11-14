import { Logger } from '@nestjs/common';
import {
  DIGEST_LEASE_MS,
  DIGEST_MAX_ATTEMPTS,
  MAX_DIGEST_ITEMS,
} from './digest-sender';
import { harness, NOW, recipientOf } from './notifications-harness.mocks-spec';

const HOUR = 60 * 60_000;
/** Before the digest hour (14:00 UTC) on the same day. */
const MORNING = new Date('2026-11-13T09:00:00Z');

function digestItem(
  h: ReturnType<typeof harness>,
  userId: string,
  extra: Record<string, unknown> = {},
) {
  return h.queued({
    userId,
    kind: 'comment-on-page',
    category: 'comments',
    delivery: 'digest',
    ...extra,
  });
}

describe('DigestSender (Chunk 14)', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it('waits for the digest hour, then sends one email per member per day', async () => {
    const h = harness();
    const items = [
      digestItem(h, 'user_a', {
        createdAt: new Date(MORNING.getTime() - HOUR),
      }),
      digestItem(h, 'user_a', {
        kind: 'reply',
        category: 'replies',
        createdAt: new Date(MORNING.getTime() - HOUR),
      }),
    ];
    await h.digests.run(MORNING);
    expect(h.mail.sendNotice).not.toHaveBeenCalled();

    await h.digests.run(NOW);
    expect(h.mail.sendNotice).toHaveBeenCalledTimes(1);
    const [row] = h.digestRows.docs;
    expect(h.mail.sendNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user_a@example.test',
        subject: 'Your ORG activity summary',
        idempotencyKey: `org-digest-${String(row._id)}-0`,
      }),
    );
    expect(row).toMatchObject({
      userId: 'user_a',
      day: '2026-11-13',
      status: 'sent',
    });
    expect(row.leaseToken).toBeUndefined();
    for (const item of items) {
      expect(item).toMatchObject({ status: 'sent', digestId: row._id });
    }
    expect(h.session.committed).toBe(1);

    // More news the same day waits for tomorrow's email.
    const later = digestItem(h, 'user_a', { createdAt: NOW });
    await h.digests.run(new Date(NOW.getTime() + HOUR));
    expect(h.mail.sendNotice).toHaveBeenCalledTimes(1);
    expect(later.status).toBe('queued');
    await h.digests.run(new Date('2026-11-14T15:00:00Z'));
    expect(h.mail.sendNotice).toHaveBeenCalledTimes(2);
    expect(later.status).toBe('sent');
  });

  it('catches up at once for news over a day old (the server slept through the hour)', async () => {
    const h = harness();
    const old = digestItem(h, 'user_a', {
      createdAt: new Date(MORNING.getTime() - 25 * HOUR),
    });
    const recent = digestItem(h, 'user_b', { createdAt: MORNING });
    await h.digests.run(MORNING);
    expect(old.status).toBe('sent');
    expect(recent.status).toBe('queued');
  });

  it('never claims a member’s day twice: a second instance gets nothing', async () => {
    const h = harness();
    digestItem(h, 'user_a');
    const first = h.digests.forMember('user_a', NOW);
    const second = h.digests.forMember('user_a', NOW);
    expect(await Promise.all([first, second])).toEqual(['sent', 'skipped']);
    expect(h.mail.sendNotice).toHaveBeenCalledTimes(1);
    // Someone with nothing waiting gets no row at all.
    expect(await h.digests.forMember('user_none', NOW)).toBe('skipped');
    expect(h.digestRows.docs).toHaveLength(1);
  });

  it('takes over a dead tick’s day with the same items and the same key', async () => {
    const h = harness();
    const item = digestItem(h, 'user_a');
    h.digestRows.docs.push({
      _id: item._id,
      userId: 'user_a',
      day: '2026-11-13',
      status: 'sending',
      itemIds: [item._id],
      attempts: 0,
      leaseUntil: new Date(NOW.getTime() + DIGEST_LEASE_MS),
      leaseToken: 'dead',
    });
    // Still held: nothing.
    expect(await h.digests.forMember('user_a', NOW)).toBe('skipped');
    const after = new Date(NOW.getTime() + DIGEST_LEASE_MS + 1);
    expect(await h.digests.forMember('user_a', after)).toBe('sent');
    expect(h.mail.sendNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `org-digest-${String(item._id)}-0`,
      }),
    );
  });

  it('retries a failed send with a new key, and then leaves the items for tomorrow', async () => {
    const h = harness();
    const item = digestItem(h, 'user_a');
    h.mail.sendNotice.mockResolvedValue('refused');
    for (let n = 1; n <= DIGEST_MAX_ATTEMPTS; n++) {
      expect(await h.digests.forMember('user_a', NOW)).toBe('failed');
      expect(h.digestRows.docs[0]).toMatchObject({
        status: 'failed',
        attempts: n,
      });
    }
    expect(await h.digests.forMember('user_a', NOW)).toBe('skipped');
    expect(item.status).toBe('queued');
    const keys = h.mail.sendNotice.mock.calls.map(
      (call) =>
        (call as unknown as [{ idempotencyKey: string }])[0].idempotencyKey,
    );
    expect(new Set(keys).size).toBe(DIGEST_MAX_ATTEMPTS);
    h.mail.sendNotice.mockResolvedValue('sent');
    expect(
      await h.digests.forMember('user_a', new Date('2026-11-14T15:00:00Z')),
    ).toBe('sent');
    expect(item.status).toBe('sent');
  });

  it('counts an unreadable account as a failed attempt', async () => {
    const h = harness();
    digestItem(h, 'user_a');
    h.targets.recipient.mockRejectedValueOnce(new Error('clerk down'));
    expect(await h.digests.forMember('user_a', NOW)).toBe('failed');
    h.targets.recipient.mockRejectedValueOnce('odd');
    expect(await h.digests.forMember('user_a', NOW)).toBe('failed');
    expect(h.digestRows.docs[0]).toMatchObject({
      status: 'failed',
      attempts: 2,
    });
  });

  it('drops what may no longer be sent, and sends nothing when nothing is left', async () => {
    const h = harness();
    const hidden = digestItem(h, 'user_a', { refs: { commentId: 'hidden' } });
    const off = digestItem(h, 'user_a', { kind: 'reply', category: 'replies' });
    const shown = digestItem(h, 'user_a', {
      kind: 'belief-agreed',
      category: 'votes',
    });
    await h.prefs.unsubscribe('user_a', 'replies');
    expect(await h.digests.forMember('user_a', NOW)).toBe('sent');
    expect([hidden, off, shown].map((r) => [r.status, r.outcome])).toEqual([
      ['skipped', 'no longer visible'],
      ['skipped', 'turned off'],
      ['sent', undefined],
    ]);

    const g = harness();
    const gone = digestItem(g, 'user_gone');
    g.targets.recipient.mockResolvedValueOnce(undefined);
    expect(await g.digests.forMember('user_gone', NOW)).toBe('skipped');
    expect(gone).toMatchObject({ status: 'skipped', outcome: 'account gone' });
    expect(g.digestRows.docs[0].status).toBe('nothing');

    const n = harness();
    const unverified = digestItem(n, 'user_n');
    n.targets.recipient.mockResolvedValueOnce({
      ...recipientOf('user_n'),
      email: undefined,
    });
    expect(await n.digests.forMember('user_n', NOW)).toBe('skipped');
    expect(unverified).toMatchObject({
      status: 'skipped',
      outcome: 'no verified address',
    });

    const d = harness();
    const digestOff = digestItem(d, 'user_d', {
      kind: 'claim-approved',
      category: 'claims',
    });
    await d.prefs.update('user_d', false, { digest: false });
    expect(await d.digests.forMember('user_d', NOW)).toBe('skipped');
    // Immediate emails are on: it goes that way instead (review L8).
    expect(digestOff).toMatchObject({
      status: 'queued',
      delivery: 'immediate',
    });
    const reply = digestItem(d, 'user_d', {
      kind: 'reply',
      category: 'replies',
    });
    expect(
      await d.digests.forMember('user_d', new Date('2026-11-14T15:00:00Z')),
    ).toBe('skipped');
    expect(reply).toMatchObject({ status: 'skipped', outcome: 'turned off' });
    expect(d.mail.sendNotice).not.toHaveBeenCalled();
  });

  it('stops short of the immediate reserve and carries the rest over, oldest first', async () => {
    const h = harness({
      config: { EMAIL_DAILY_LIMIT: 3, EMAIL_IMMEDIATE_RESERVE: 2 },
    });
    const a = digestItem(h, 'user_a', {
      createdAt: new Date(NOW.getTime() - 2 * HOUR),
    });
    const b = digestItem(h, 'user_b', {
      createdAt: new Date(NOW.getTime() - HOUR),
    });
    await h.digests.run(NOW);
    expect(a.status).toBe('sent');
    expect(b.status).toBe('queued');
    expect(h.digestRows.docs.find((r) => r.userId === 'user_b')?.status).toBe(
      'deferred',
    );
    // Room for immediate emails is still there.
    expect(await h.budget.take('immediate', NOW)).toBe(true);
    // Tomorrow it goes, in a new day's row.
    await h.digests.run(new Date('2026-11-14T15:00:00Z'));
    expect(b.status).toBe('sent');
  });

  it('takes a deferred day back once there is budget again', async () => {
    const h = harness();
    const item = digestItem(h, 'user_a');
    h.digestRows.docs.push({
      userId: 'user_a',
      day: '2026-11-13',
      status: 'deferred',
      itemIds: [item._id],
      attempts: 0,
    });
    expect(await h.digests.forMember('user_a', NOW)).toBe('sent');
  });

  it('holds at most the item limit in one email, and logs a member that fails', async () => {
    const h = harness();
    for (let n = 0; n < MAX_DIGEST_ITEMS + 2; n++) digestItem(h, 'user_a');
    expect(await h.digests.forMember('user_a', NOW)).toBe('sent');
    expect(h.queue.docs.filter((d) => d.status === 'queued')).toHaveLength(2);

    const broken = harness();
    digestItem(broken, 'user_a');
    jest
      .spyOn(broken.digests, 'forMember')
      .mockRejectedValueOnce(new Error('boom'));
    await broken.digests.run(NOW);
    expect(error).toHaveBeenCalledWith('A digest failed: boom');
    jest.spyOn(broken.digests, 'forMember').mockRejectedValueOnce('odd');
    await broken.digests.run(NOW);
    expect(error).toHaveBeenCalledWith('A digest failed: odd');
  });

  it('passes on a claim that fails for another reason than a race', async () => {
    const h = harness();
    digestItem(h, 'user_a');
    jest
      .spyOn(h.digestRows, 'create')
      .mockRejectedValueOnce(new Error('disk full'));
    await expect(h.digests.forMember('user_a', NOW)).rejects.toThrow(
      'disk full',
    );
  });
});
