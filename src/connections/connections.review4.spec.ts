// Review round 4 of Chunk 18: every entry point expires stale requests
// before it acts; admins see why a record ended, members never do; the
// blocker is not credited with a decline they never made; the send and the
// profile button agree even with a live record and a member who is gone.
import { HttpException } from '@nestjs/common';
import { Types } from 'mongoose';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { NotificationTargets } from '../member-notifications/notification-targets.service';
import { messagesFor } from './connection-messages';
import { pairKeyOf } from './connection-rules';
import { DEFAULT_TERMS } from './connection-terms.service';
import { harness, NOW, page } from './connections-harness.mocks-spec';

const M = messagesFor(DEFAULT_TERMS);
const DAY = 24 * 60 * 60_000;
const R = 'user_requester';
const T = 'user_target';
const STALE = new Types.ObjectId('0123456789abcdef01234567');
const READER = (userId: string) => ({
  kind: 'named-member' as const,
  userId,
  isAdmin: false,
});

/** A request nobody answered for 100 days that no sweep has reached yet. */
function staleRow(from = R, to = T) {
  return {
    _id: STALE,
    fromUserId: from,
    toUserId: to,
    pairKey: pairKeyOf(R, T),
    status: 'pending',
    live: true,
    note: 'Synthetic old note',
    createdAt: new Date(NOW.getTime() - 100 * DAY),
  };
}

function build(connections: Array<Record<string, unknown>> = [staleRow()]) {
  return harness({
    pages: [page(R, 'member-r'), page(T, 'member-t')],
    connections,
  });
}

async function quietly(promise: Promise<unknown>) {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      return { status: error.getStatus(), message: error.message };
    }
    throw error;
  }
}

describe('#1 a block on a stale, unswept request', () => {
  it('expires it first: no decline, no 30-day wait', async () => {
    const h = build();
    await h.service.block(T, { slug: 'member-r' }, NOW);
    expect(h.connections.docs[0]).toMatchObject({ status: 'expired' });
    await expect(h.views.relation(R, 'member-t', NOW)).resolves.toMatchObject({
      reason: 'not-open',
    });
  });
});

// The method-by-method expire-before-act check moved to
// connections.expire-first.spec.ts (review round 5), and grew stricter.

describe('#1 an email about a stale request', () => {
  it('is dropped even before the sweep reaches it', async () => {
    const targets = new NotificationTargets(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      build().connections as never,
      fakeModel([]) as never,
    );
    await expect(
      targets.describe(
        {
          kind: 'connection-requested',
          refs: { connectionId: STALE },
        } as never,
        {
          userId: T,
          isAdmin: false,
          viewer: READER(T),
        },
      ),
    ).resolves.toBeUndefined();
  });
});

describe('#3 why a record ended is for admins only', () => {
  it('admins see it; no member view or export carries it', async () => {
    const h = build([{ ...staleRow(), createdAt: NOW }]);
    await h.service.block(T, { slug: 'member-r' }, NOW);
    // The upsert's timestamps, as Mongoose sets them.
    for (const doc of h.blocks.docs) doc.createdAt = NOW;
    expect(
      (await h.records.noteViews([String(STALE)], NOW)).get(String(STALE)),
    ).toMatchObject({ status: 'declined', endReason: 'block' });
    for (const reader of [R, T]) {
      const member = JSON.stringify([
        await h.views.overview(reader, NOW),
        await quietly(
          h.views.relation(reader, reader === R ? 'member-t' : 'member-r', NOW),
        ),
        await h.records.exportFor(reader, READER(reader), NOW),
      ]);
      expect(member).not.toContain('endReason');
      expect(member).not.toContain('endedBy');
    }
  });
});

describe('#4 the blocker is not credited with a decline or a withdrawal', () => {
  it('shows the blocker "ended", by their block; the blocked member is unchanged', async () => {
    // T blocks while R's request to T waits.
    const one = build([{ ...staleRow(), createdAt: NOW }]);
    await one.service.block(T, { slug: 'member-r' }, NOW);
    const blocker = await one.records.exportFor(T, READER(T), NOW);
    expect(blocker.requestsReceived[0]).toEqual(
      expect.objectContaining({
        status: 'ended',
        endedAt: NOW.toISOString(),
        youBlockedThisMember: true,
      }),
    );
    const blocked = await one.records.exportFor(R, READER(R), NOW);
    expect(blocked.requestsSent[0]).toMatchObject({ status: 'closed' });
    expect(JSON.stringify(blocked)).not.toContain('youBlocked');
    // T blocks while T's own request to R waits.
    const two = build([{ ...staleRow(T, R), createdAt: NOW }]);
    await two.service.block(T, { slug: 'member-r' }, NOW);
    expect(
      (await two.records.exportFor(T, READER(T), NOW)).requestsSent[0],
    ).toEqual(
      expect.objectContaining({ status: 'ended', youBlockedThisMember: true }),
    );
    const other = await two.records.exportFor(R, READER(R), NOW);
    expect(other.requestsReceived[0]).toMatchObject({ status: 'withdrawn' });
    expect(JSON.stringify(other)).not.toContain('youBlocked');
  });
});

describe('#5 send and the profile button agree with a live record and a member who is gone', () => {
  it('for a request each way and a connection', async () => {
    const rows = {
      'R→T pending': { fromUserId: R, toUserId: T, status: 'pending' },
      'T→R pending': { fromUserId: T, toUserId: R, status: 'pending' },
      connected: {
        fromUserId: R,
        toUserId: T,
        status: 'accepted',
        decidedAt: NOW,
      },
    };
    const disagree: string[] = [];
    for (const [state, fields] of Object.entries(rows)) {
      const h = build([
        {
          _id: new Types.ObjectId(),
          pairKey: pairKeyOf(R, T),
          live: true,
          createdAt: NOW,
          ...fields,
        },
      ]);
      h.accounts.docs.push({ userId: T, at: NOW, purgeAfter: NOW });
      const relation = (await h.views.relation(R, 'member-t', NOW)) as {
        state: string;
        reason?: string;
      };
      const sent = await quietly(h.service.send(R, 'member-t', undefined, NOW));
      const expected =
        relation.state === 'none' && relation.reason === 'not-open'
          ? { status: 403, message: M.notOpen }
          : 'a live state';
      if (JSON.stringify(sent) !== JSON.stringify(expected)) {
        disagree.push(
          `${state}: ${JSON.stringify(relation)} vs ${JSON.stringify(sent)}`,
        );
      }
    }
    expect(disagree).toEqual([]);
  });
});
