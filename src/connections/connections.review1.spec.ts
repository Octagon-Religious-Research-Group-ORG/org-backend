// Review round 1 of Chunk 18: each case here failed on the first build.
import { HttpException } from '@nestjs/common';
import { Types } from 'mongoose';
import { messagesFor } from './connection-messages';
import { pairKeyOf } from './connection-rules';
import { DEFAULT_TERMS } from './connection-terms.service';
import { ConnectionExpiryScheduler } from './connection-expiry.scheduler';
import {
  A,
  B,
  C,
  D,
  F,
  harness,
  NOW,
  page,
  seedPages,
} from './connections-harness.mocks-spec';

const M = messagesFor(DEFAULT_TERMS);
const DAY = 24 * 60 * 60_000;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      return { status: error.getStatus(), message: error.message };
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

function row(from: string, to: string, over: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    fromUserId: from,
    toUserId: to,
    pairKey: pairKeyOf(from, to),
    status: 'pending',
    live: true,
    createdAt: NOW,
    ...over,
  };
}

describe('#1 a page the sender cannot see is never reachable', () => {
  it('answers a Private member open to anyone exactly like a missing page', async () => {
    const h = harness({ settings: [{ userId: C, openTo: 'any-member' }] });
    await expect(
      refusal(h.service.send(A, 'member-c', undefined, NOW)),
    ).resolves.toEqual(
      await refusal(h.service.send(A, 'no-such-page', undefined, NOW)),
    );
    expect(h.connections.docs).toHaveLength(0);
  });

  it('never names a member the reader cannot see, unless they sent the request or are connected', async () => {
    const h = harness({
      connections: [row(C, A), row(C, D, { status: 'accepted' })],
      blocks: [{ blockerUserId: B, blockedUserId: C, createdAt: NOW }],
    });
    // B blocked C through a request; B cannot see C's Private page.
    expect((await h.views.overview(B)).blocked[0].member).toEqual({
      name: 'A member',
    });
    // C sent A a request: A sees C's name (C chose to write).
    expect((await h.views.overview(A)).incoming[0].member).toEqual({
      name: 'Member C',
    });
    // D and C are connected: D sees C's name.
    expect((await h.views.overview(D)).connected[0].member).toEqual({
      name: 'Member C',
    });
  });
});

describe('#2 requests to a member who lost their page', () => {
  it('do not count toward the 20, and stay listed as unavailable with a working withdraw', async () => {
    const others = Array.from({ length: 19 }, (_, n) =>
      page(`user_x${n}`, `extra-${n}`),
    );
    const toF = row(A, F, { note: 'old' });
    const h = harness({
      pages: [...seedPages(), ...others],
      connections: [toF, ...others.map((p) => row(A, p.ownerUserId))],
    });
    await expect(
      h.service.send(A, 'member-b', undefined, NOW),
    ).resolves.toEqual(expect.objectContaining({ status: 'pending' }));
    const outgoing = (await h.views.overview(A)).outgoing;
    const unavailable = outgoing.find((r) => r.id === String(toF._id));
    expect(outgoing.filter((r) => r.unavailable)).toHaveLength(1);
    expect(unavailable).toMatchObject({
      member: { name: 'A member' },
      unavailable: true,
    });
    await expect(
      h.service.withdraw(A, unavailable!.id, NOW),
    ).resolves.toMatchObject({ status: 'withdrawn' });
  });
});

describe('#3 the sender cannot tell a block from a decline or an expiry', () => {
  it('shows one generic "closed" with a single closedAt', async () => {
    const h = harness({
      connections: [
        row(A, B, { status: 'declined', live: undefined, decidedAt: NOW }),
        row(A, D, {
          status: 'ended',
          live: undefined,
          endedAt: NOW,
          endReason: 'block',
        }),
        row(A, F, { status: 'expired', live: undefined, endedAt: NOW }),
        row(C, A, {
          status: 'ended',
          live: undefined,
          endedAt: NOW,
          endReason: 'block',
        }),
      ],
    });
    const data = await h.records.exportFor(A, {
      kind: 'named-member',
      userId: A,
      isAdmin: false,
    });
    for (const sent of data.requestsSent) {
      expect(Object.keys(sent).sort()).toEqual([
        'closedAt',
        'sentAt',
        'status',
        'to',
      ]);
      expect(sent).toMatchObject({
        status: 'closed',
        closedAt: NOW.toISOString(),
      });
    }
    expect(data.requestsReceived[0]).toMatchObject({ status: 'closed' });
  });
});

describe('#4 a block that lands mid-send is answered through the one refusal path', () => {
  it('gives "not open" on a visible page', async () => {
    const h = harness({
      beforeSettingsWrite: (operation) => {
        if (operation === 'updateOne' && h.blocks.docs.length === 0) {
          h.blocks.docs.push({ blockerUserId: B, blockedUserId: A });
        }
      },
    });
    await expect(
      refusal(h.service.send(A, 'member-b', undefined, NOW)),
    ).resolves.toEqual({ status: 403, message: M.notOpen });
  });
});

describe('#5 "Private only to Public" holds at accept time', () => {
  it('refuses the accept and closes the request when the recipient is no longer Public', async () => {
    const h = harness({ connections: [row(C, A)] });
    h.profiles.docs.find((p) => p.ownerUserId === A)!.visibility = 'members';
    await expect(
      refusal(h.service.accept(A, String(h.connections.docs[0]._id), NOW)),
    ).resolves.toEqual({ status: 403, message: M.noLongerAllowed });
    expect(h.connections.docs[0]).toMatchObject({ status: 'closed' });
    expect(h.connections.docs[0].live).toBeUndefined();
    expect(h.notifier.connectionAccepted).not.toHaveBeenCalled();
  });
});

describe('#7 an ignored request expires after 90 days', () => {
  const old = new Date(NOW.getTime() - 91 * DAY);

  it('leaves the recipient’s list, frees the pair with no wait, and stops counting', async () => {
    const h = harness({ connections: [row(A, B, { createdAt: old })] });
    expect((await h.views.overview(B)).incoming).toEqual([]);
    expect(h.connections.docs[0]).toMatchObject({ status: 'expired' });
    await expect(
      h.service.send(A, 'member-b', undefined, NOW),
    ).resolves.toEqual(expect.objectContaining({ status: 'pending' }));
    expect((await h.views.overview(A)).me.pendingSent).toBe(1);
  });

  it('is swept by the hourly job too', async () => {
    const h = harness({
      connections: [row(A, B, { createdAt: old }), row(A, D)],
    });
    const scheduler = new ConnectionExpiryScheduler(h.records);
    await scheduler.tick(NOW);
    expect(h.connections.docs.map((r) => r.status)).toEqual([
      'expired',
      'pending',
    ]);
  });
});

describe('round 1 edges', () => {
  it('does not count requests to a deleted page or a deleted account, and shows a withdrawal as itself', async () => {
    const h = harness({
      connections: [
        row(A, 'user_g'),
        row(A, 'user_h'),
        row(A, D, { status: 'withdrawn', live: undefined, endedAt: NOW }),
        row(B, A, { status: 'declined', live: undefined, decidedAt: NOW }),
        // D's page predates the review field: it counts as approved.
        row(A, D, { pairKey: 'd-again' }),
      ],
    });
    expect((await h.views.overview(A)).me.pendingSent).toBe(1);
    const data = await h.records.exportFor(A, {
      kind: 'named-member',
      userId: A,
      isAdmin: false,
    });
    expect(data.requestsSent[2]).toMatchObject({
      status: 'withdrawn',
      endedAt: NOW.toISOString(),
    });
    // The member's own decline reads as itself.
    expect(data.requestsReceived[0]).toMatchObject({
      status: 'declined',
      answeredAt: NOW.toISOString(),
    });
  });
});
