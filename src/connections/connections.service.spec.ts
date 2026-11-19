import { HttpException } from '@nestjs/common';
import { Types } from 'mongoose';
import { messagesFor } from './connection-messages';
import { pairKeyOf } from './connection-rules';
import {
  A,
  B,
  C,
  D,
  E,
  F,
  G,
  H,
  harness,
  NOBODY,
  NOW,
  extraPages,
  seedPages,
} from './connections-harness.mocks-spec';
import { DEFAULT_TERMS } from './connection-terms.service';

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

describe('ConnectionsService.send', () => {
  it('sends a request with a note and tells the recipient', async () => {
    const h = harness();
    const result = await h.service.send(A, 'Member-B', '  hello there  ', NOW);
    expect(result.status).toBe('pending');
    expect(h.connections.docs).toHaveLength(1);
    expect(h.connections.docs[0]).toMatchObject({
      fromUserId: A,
      toUserId: B,
      pairKey: pairKeyOf(A, B),
      status: 'pending',
      live: true,
      note: 'hello there',
    });
    expect(h.notifier.connectionRequested).toHaveBeenCalledWith({
      connectionId: String(h.connections.docs[0]._id),
      fromUserId: A,
      toUserId: B,
      at: NOW,
    });
    // The sender's gate row is written, so two sends at once are ordered.
    expect(h.settings.docs[0]).toMatchObject({ userId: A, gateAt: NOW });
    expect(h.session.committed).toBe(1);
  });

  it('drops a note with nothing visible, and refuses one over 500 characters', async () => {
    const h = harness();
    await h.service.send(A, 'member-b', ' ​ ', NOW);
    expect(h.connections.docs[0].note).toBeUndefined();
    await expect(
      refusal(h.service.send(A, 'member-d', 'x'.repeat(501), NOW)),
    ).resolves.toEqual({ status: 400, message: M.noteTooLong });
  });

  it('refuses a request to yourself', async () => {
    await expect(
      refusal(harness().service.send(A, 'member-a', undefined, NOW)),
    ).resolves.toEqual({ status: 400, message: M.self });
  });

  it('refuses senders without an approved page', async () => {
    for (const userId of [NOBODY, E, F, G, H]) {
      await expect(
        refusal(harness().service.send(userId, 'member-a', undefined, NOW)),
      ).resolves.toEqual({ status: 403, message: M.notEligible });
    }
  });

  it('answers pages a member cannot see like pages that do not exist', async () => {
    const h = harness();
    // Bad address, unknown address, waiting, removed, deleted, Private.
    for (const slug of ['Not A Slug!', 'nobody-here', 'member-e', 'member-f']) {
      await expect(
        refusal(h.service.send(A, slug, undefined, NOW)),
      ).resolves.toEqual({ status: 404, message: M.pageNotFound });
    }
    for (const slug of ['member-g', 'member-c']) {
      await expect(
        refusal(h.service.send(A, slug, undefined, NOW)),
      ).resolves.toEqual({ status: 404, message: M.pageNotFound });
    }
  });

  it('answers a page with no live member behind it as not open', async () => {
    const h = harness();
    // An imported page nobody claimed, and a member whose account is gone.
    for (const slug of ['member-i', 'member-h']) {
      await expect(
        refusal(h.service.send(A, slug, undefined, NOW)),
      ).resolves.toEqual({ status: 403, message: M.notOpen });
    }
  });

  it('lets a Private member request only a Public member', async () => {
    const h = harness();
    await expect(
      refusal(h.service.send(C, 'member-b', undefined, NOW)),
    ).resolves.toEqual({ status: 403, message: M.privateNeedsPublic });
    await expect(
      refusal(h.service.send(C, 'member-d', undefined, NOW)),
    ).resolves.toEqual({ status: 403, message: M.privateNeedsPublic });
    await expect(
      h.service.send(C, 'member-a', undefined, NOW),
    ).resolves.toEqual(expect.objectContaining({ status: 'pending' }));
  });

  it('honours the recipient’s "open to" setting', async () => {
    const h = harness({
      settings: [
        { userId: B, openTo: 'public-members' },
        { userId: D, openTo: 'nobody' },
      ],
    });
    // D's page is named-members only, so D is not a Public member.
    await expect(
      refusal(h.service.send(D, 'member-b', undefined, NOW)),
    ).resolves.toEqual({ status: 403, message: M.notOpen });
    await expect(
      h.service.send(A, 'member-b', undefined, NOW),
    ).resolves.toBeDefined();
    await expect(
      refusal(h.service.send(A, 'member-d', undefined, NOW)),
    ).resolves.toEqual({ status: 403, message: M.notOpen });
  });

  it('never reaches a Private member, even one open to any member (review round 1)', async () => {
    const h = harness({ settings: [{ userId: C, openTo: 'any-member' }] });
    await expect(
      refusal(h.service.send(B, 'member-c', undefined, NOW)),
    ).resolves.toEqual({ status: 404, message: M.pageNotFound });
  });

  it('answers a block, either way, exactly like a member who is not open', async () => {
    const closed = harness({ settings: [{ userId: B, openTo: 'nobody' }] });
    const notOpen = await refusal(
      closed.service.send(A, 'member-b', undefined, NOW),
    );
    const theyBlocked = harness({
      blocks: [{ blockerUserId: B, blockedUserId: A }],
    });
    const iBlocked = harness({
      blocks: [{ blockerUserId: A, blockedUserId: B }],
    });
    await expect(
      refusal(theyBlocked.service.send(A, 'member-b', undefined, NOW)),
    ).resolves.toEqual(notOpen);
    await expect(
      refusal(iBlocked.service.send(A, 'member-b', undefined, NOW)),
    ).resolves.toEqual(notOpen);
    // And a blocked request to a Private member reads as a missing page.
    const hidden = harness({
      settings: [{ userId: C, openTo: 'any-member' }],
      blocks: [{ blockerUserId: C, blockedUserId: A }],
    });
    await expect(
      refusal(hidden.service.send(A, 'member-c', undefined, NOW)),
    ).resolves.toEqual({ status: 404, message: M.pageNotFound });
  });

  it('allows at most 20 requests waiting for an answer', async () => {
    const pending = Array.from({ length: 20 }, (_, n) => row(A, `user_x${n}`));
    const h = harness({
      pages: [...seedPages(), ...extraPages('user_x', 20)],
      connections: pending,
    });
    await expect(
      refusal(h.service.send(A, 'member-b', undefined, NOW)),
    ).resolves.toEqual({ status: 429, message: M.limit });
    h.connections.docs[0].status = 'withdrawn';
    delete h.connections.docs[0].live;
    await expect(
      h.service.send(A, 'member-b', undefined, NOW),
    ).resolves.toBeDefined();
  });

  it('makes the sender of a declined request wait 30 days', async () => {
    const declinedAt = new Date(NOW.getTime() - 10 * DAY);
    const h = harness({
      connections: [
        row(A, B, {
          status: 'declined',
          live: undefined,
          decidedAt: declinedAt,
        }),
      ],
    });
    await expect(
      refusal(h.service.send(A, 'member-b', undefined, NOW)),
    ).resolves.toEqual({
      status: 403,
      message: M.cooldown(new Date(declinedAt.getTime() + 30 * DAY)),
    });
    // The other way round is not held back.
    await expect(
      h.service.send(B, 'member-a', undefined, NOW),
    ).resolves.toBeDefined();
    const later = new Date(declinedAt.getTime() + 30 * DAY + 1);
    const h2 = harness({
      connections: [
        row(A, B, {
          status: 'declined',
          live: undefined,
          decidedAt: declinedAt,
        }),
      ],
    });
    await expect(
      h2.service.send(A, 'member-b', undefined, later),
    ).resolves.toBeDefined();
  });

  it('refuses a second request, and one to a member already connected', async () => {
    const h = harness();
    await h.service.send(A, 'member-b', undefined, NOW);
    await expect(
      refusal(h.service.send(A, 'member-b', undefined, NOW)),
    ).resolves.toEqual({ status: 409, message: M.alreadySent });
    await h.service.accept(B, String(h.connections.docs[0]._id), NOW);
    for (const [from, slug] of [
      [A, 'member-b'],
      [B, 'member-a'],
    ]) {
      await expect(
        refusal(h.service.send(from, slug, undefined, NOW)),
      ).resolves.toEqual({ status: 409, message: M.alreadyConnected });
    }
  });

  it('treats a request crossing one already waiting from the other side as accepting it', async () => {
    const h = harness({ connections: [row(B, A)] });
    const result = await h.service.send(A, 'member-b', 'hi', NOW);
    expect(result).toEqual({
      status: 'accepted',
      id: String(h.connections.docs[0]._id),
      crossed: true,
    });
    expect(h.connections.docs).toHaveLength(1);
    expect(h.connections.docs[0]).toMatchObject({
      status: 'accepted',
      decidedAt: NOW,
      live: true,
    });
    expect(h.notifier.connectionAccepted).toHaveBeenCalledWith({
      connectionId: String(h.connections.docs[0]._id),
      fromUserId: B,
      acceptedBy: A,
      at: NOW,
    });
    expect(h.notifier.connectionRequested).not.toHaveBeenCalled();
  });

  it('resolves a request that lost a race the same way: crossed is accepted, same way is a conflict', async () => {
    // Another request lands between the read and the insert.
    let sneak: Record<string, unknown> | undefined;
    const crossed = harness({
      beforeConnectionWrite: (operation) => {
        if (operation === 'create' && !sneak) {
          sneak = row(B, A);
          crossed.connections.docs.push(sneak);
        }
      },
    });
    await expect(
      crossed.service.send(A, 'member-b', undefined, NOW),
    ).resolves.toEqual(expect.objectContaining({ status: 'accepted' }));
    expect(crossed.connections.docs).toHaveLength(1);

    let twin: Record<string, unknown> | undefined;
    const same = harness({
      beforeConnectionWrite: (operation) => {
        if (operation === 'create' && !twin) {
          twin = row(A, B);
          same.connections.docs.push(twin);
        }
      },
    });
    await expect(
      refusal(same.service.send(A, 'member-b', undefined, NOW)),
    ).resolves.toEqual({ status: 409, message: M.alreadySent });
    expect(same.connections.docs).toHaveLength(1);
  });

  it('passes on a database failure that is not a duplicate', async () => {
    const h = harness({
      beforeConnectionWrite: (operation) => {
        if (operation === 'create') throw new Error('disk on fire');
      },
    });
    await expect(h.service.send(A, 'member-b', undefined, NOW)).rejects.toThrow(
      'disk on fire',
    );
  });

  it('refuses when the live row vanished before it could be read back', async () => {
    const h = harness({
      beforeConnectionWrite: (operation) => {
        if (operation === 'create') {
          throw Object.assign(new Error('E11000'), {
            code: 11000,
            keyPattern: { pairKey: 1 },
          });
        }
      },
    });
    await expect(
      refusal(h.service.send(A, 'member-b', undefined, NOW)),
    ).resolves.toEqual({ status: 409, message: M.changed });
  });
});

describe('ConnectionsService answers', () => {
  it('accept: only the recipient, and both must still be members', async () => {
    const h = harness({ connections: [row(A, B)] });
    const id = String(h.connections.docs[0]._id);
    await expect(refusal(h.service.accept(A, id, NOW))).resolves.toEqual({
      status: 404,
      message: M.notFound,
    });
    await expect(h.service.accept(B, id, NOW)).resolves.toEqual({
      status: 'accepted',
      id,
    });
    expect(h.connections.docs[0]).toMatchObject({
      status: 'accepted',
      live: true,
      decidedAt: NOW,
    });
    expect(h.notifier.connectionAccepted).toHaveBeenCalledWith({
      connectionId: id,
      fromUserId: A,
      acceptedBy: B,
      at: NOW,
    });
    await expect(refusal(h.service.accept(B, id, NOW))).resolves.toEqual({
      status: 404,
      message: M.notFound,
    });
    await expect(
      refusal(h.service.accept(B, 'not-an-id', NOW)),
    ).resolves.toEqual({ status: 404, message: M.notFound });
  });

  it('accept: refused to a recipient who lost their page, gone when the sender did', async () => {
    const toRemoved = harness({ connections: [row(A, F)] });
    await expect(
      refusal(
        toRemoved.service.accept(
          F,
          String(toRemoved.connections.docs[0]._id),
          NOW,
        ),
      ),
    ).resolves.toEqual({ status: 403, message: M.notEligible });
    const fromGone = harness({ connections: [row(G, A)] });
    await expect(
      refusal(
        fromGone.service.accept(
          A,
          String(fromGone.connections.docs[0]._id),
          NOW,
        ),
      ),
    ).resolves.toEqual({ status: 404, message: M.notFound });
  });

  it('accept: a request that changed meanwhile is a conflict', async () => {
    const h = harness({
      connections: [row(A, B)],
      beforeConnectionWrite: (operation) => {
        if (operation === 'updateOne')
          h.connections.docs[0].status = 'withdrawn';
      },
    });
    await expect(
      refusal(h.service.accept(B, String(h.connections.docs[0]._id), NOW)),
    ).resolves.toEqual({ status: 409, message: M.changed });
  });

  it('decline: frees the pair and starts the 30-day wait', async () => {
    const h = harness({ connections: [row(A, B)] });
    const id = String(h.connections.docs[0]._id);
    await expect(refusal(h.service.decline(A, id, NOW))).resolves.toEqual({
      status: 404,
      message: M.notFound,
    });
    await expect(h.service.decline(B, id, NOW)).resolves.toEqual({
      status: 'declined',
      id,
    });
    expect(h.connections.docs[0]).toMatchObject({
      status: 'declined',
      decidedAt: NOW,
    });
    expect(h.connections.docs[0].live).toBeUndefined();
    expect(h.notifier.connectionAccepted).not.toHaveBeenCalled();
  });

  it('withdraw: only the sender, only while it waits', async () => {
    const h = harness({ connections: [row(A, B)] });
    const id = String(h.connections.docs[0]._id);
    await expect(refusal(h.service.withdraw(B, id, NOW))).resolves.toEqual({
      status: 404,
      message: M.notFound,
    });
    await expect(h.service.withdraw(A, id, NOW)).resolves.toEqual({
      status: 'withdrawn',
      id,
    });
    expect(h.connections.docs[0]).toMatchObject({
      status: 'withdrawn',
      endedAt: NOW,
    });
    // A withdrawn request is no reason to wait.
    await expect(
      h.service.send(A, 'member-b', undefined, NOW),
    ).resolves.toBeDefined();
  });

  it('disconnect: either side, only a connection', async () => {
    const h = harness({
      connections: [row(A, B, { status: 'accepted' }), row(A, D)],
    });
    const id = String(h.connections.docs[0]._id);
    await expect(refusal(h.service.disconnect(C, id, NOW))).resolves.toEqual({
      status: 404,
      message: M.notFound,
    });
    await expect(
      refusal(h.service.disconnect(A, String(h.connections.docs[1]._id), NOW)),
    ).resolves.toEqual({ status: 404, message: M.notFound });
    await expect(h.service.disconnect(B, id, NOW)).resolves.toEqual({
      status: 'ended',
      id,
    });
    expect(h.connections.docs[0]).toMatchObject({
      status: 'ended',
      endReason: 'disconnect',
      endedAt: NOW,
    });
    expect(h.connections.docs[0].live).toBeUndefined();
  });
});

describe('ConnectionsService blocks', () => {
  it('blocks by address, ending everything between the two, and unblocks', async () => {
    const h = harness({
      connections: [row(A, B, { status: 'accepted' })],
    });
    await expect(
      h.service.block(A, { slug: 'member-b' }, NOW),
    ).resolves.toEqual({ blocked: true });
    expect(h.blocks.docs[0]).toMatchObject({
      blockerUserId: A,
      blockedUserId: B,
    });
    expect(h.connections.docs[0]).toMatchObject({
      status: 'ended',
      endReason: 'block',
    });
    // Both members' gate rows are written.
    expect(h.settings.docs.map((s) => s.userId).sort()).toEqual([A, B]);
    // Blocking twice changes nothing.
    await h.service.block(A, { slug: 'member-b' }, NOW);
    expect(h.blocks.docs).toHaveLength(1);
    const blockId = String(h.blocks.docs[0]._id);
    await expect(refusal(h.service.unblock(B, blockId))).resolves.toEqual({
      status: 404,
      message: M.blockNotFound,
    });
    await expect(refusal(h.service.unblock(A, 'nope'))).resolves.toEqual({
      status: 404,
      message: M.blockNotFound,
    });
    await expect(h.service.unblock(A, blockId)).resolves.toEqual({
      blocked: false,
    });
    expect(h.blocks.docs).toHaveLength(0);
  });

  it('blocks the sender of a request from a Private member, by the request', async () => {
    const h = harness({ connections: [row(C, A)] });
    const id = String(h.connections.docs[0]._id);
    await expect(
      h.service.block(A, { connectionId: id }, NOW),
    ).resolves.toEqual({ blocked: true });
    expect(h.blocks.docs[0]).toMatchObject({
      blockerUserId: A,
      blockedUserId: C,
    });
    // To C it reads as a decline (review round 3); admins see the block.
    expect(h.connections.docs[0]).toMatchObject({
      status: 'declined',
      endReason: 'block',
    });
  });

  it('refuses blocking what the member cannot name, themselves, or without a page', async () => {
    const h = harness({ connections: [row(B, D)] });
    await expect(
      refusal(h.service.block(A, { slug: 'member-c' }, NOW)),
    ).resolves.toEqual({ status: 404, message: M.pageNotFound });
    await expect(
      refusal(h.service.block(A, { slug: 'member-i' }, NOW)),
    ).resolves.toEqual({ status: 404, message: M.pageNotFound });
    await expect(
      refusal(
        h.service.block(
          A,
          { connectionId: String(h.connections.docs[0]._id) },
          NOW,
        ),
      ),
    ).resolves.toEqual({ status: 404, message: M.notFound });
    await expect(
      refusal(h.service.block(A, { connectionId: 'zz' }, NOW)),
    ).resolves.toEqual({ status: 404, message: M.notFound });
    await expect(refusal(h.service.block(A, {}, NOW))).resolves.toEqual({
      status: 404,
      message: M.pageNotFound,
    });
    await expect(
      refusal(h.service.block(A, { slug: 'member-a' }, NOW)),
    ).resolves.toEqual({ status: 400, message: M.selfBlock });
    await expect(
      refusal(h.service.block(NOBODY, { slug: 'member-a' }, NOW)),
    ).resolves.toEqual({ status: 403, message: M.notEligible });
  });
});

describe('ConnectionsService contact sharing', () => {
  const contacts = [
    { userId: B, contacts: [{ method: 'signal', value: 'b-hidden-row' }] },
  ];

  it('shows a connected member every contact row, page and connections-only', async () => {
    const h = harness({
      connections: [row(A, B, { status: 'accepted' })],
      settings: contacts,
    });
    const relation = await h.views.relation(A, 'member-b', NOW);
    expect(relation).toMatchObject({
      state: 'connected',
      contacts: [
        { method: 'telegram', value: '@member-b-page' },
        { method: 'signal', value: 'b-hidden-row' },
      ],
    });
  });

  it('shows nothing extra to anyone not connected, and stops at once on disconnect', async () => {
    const h = harness({
      connections: [row(A, B, { status: 'accepted' })],
      settings: contacts,
    });
    const id = String(h.connections.docs[0]._id);
    const pending = harness({ connections: [row(A, B)], settings: contacts });
    expect(
      JSON.stringify(await pending.views.relation(A, 'member-b', NOW)),
    ).not.toContain('b-hidden-row');
    await h.service.disconnect(A, id, NOW);
    expect(
      JSON.stringify(await h.views.relation(A, 'member-b', NOW)),
    ).not.toContain('b-hidden-row');
    expect(JSON.stringify(await h.views.overview(A))).not.toContain(
      'b-hidden-row',
    );
  });

  it('stops sharing when either member loses their page', async () => {
    const h = harness({
      connections: [row(A, B, { status: 'accepted' })],
      settings: contacts,
    });
    h.profiles.docs.find((p) => p.ownerUserId === B)!.reviewStatus = 'removed';
    expect(JSON.stringify(await h.views.overview(A))).not.toContain(
      'b-hidden-row',
    );
  });
});

describe('ConnectionsService.relation', () => {
  it('describes each state the profile button needs', async () => {
    const h = harness({
      connections: [row(A, B), row(D, A)],
      blocks: [{ blockerUserId: A, blockedUserId: 'user_x' }],
    });
    await expect(h.views.relation(A, 'member-a', NOW)).resolves.toEqual({
      state: 'self',
    });
    await expect(h.views.relation(A, 'member-b', NOW)).resolves.toEqual({
      state: 'outgoing',
      id: String(h.connections.docs[0]._id),
    });
    await expect(h.views.relation(A, 'member-d', NOW)).resolves.toEqual({
      state: 'incoming',
      id: String(h.connections.docs[1]._id),
    });
    await expect(h.views.relation(B, 'member-d', NOW)).resolves.toEqual({
      state: 'none',
      canRequest: true,
    });
    await expect(h.views.relation(NOBODY, 'member-a', NOW)).resolves.toEqual({
      state: 'none',
      canRequest: false,
      reason: 'not-eligible',
    });
    await expect(h.views.relation(A, 'member-i', NOW)).resolves.toEqual({
      state: 'none',
      canRequest: false,
      reason: 'not-open',
    });
    await expect(
      refusal(h.views.relation(A, 'member-c', NOW)),
    ).resolves.toEqual({ status: 404, message: M.pageNotFound });
  });

  it('names a block the member made, and hides one made against them', async () => {
    const mine = harness({ blocks: [{ blockerUserId: A, blockedUserId: B }] });
    await expect(mine.views.relation(A, 'member-b', NOW)).resolves.toEqual({
      state: 'blocked',
      blockId: String(mine.blocks.docs[0]._id),
    });
    await expect(mine.views.relation(B, 'member-a', NOW)).resolves.toEqual({
      state: 'none',
      canRequest: false,
      reason: 'not-open',
    });
  });

  it('gives the reason a request cannot be sent', async () => {
    const declinedAt = new Date(NOW.getTime() - DAY);
    const h = harness({
      connections: [
        row(A, B, {
          status: 'declined',
          live: undefined,
          decidedAt: declinedAt,
        }),
        ...Array.from({ length: 20 }, (_, n) => row(D, `user_y${n}`)),
      ],
      pages: [...seedPages(), ...extraPages('user_y', 20)],
    });
    await expect(h.views.relation(A, 'member-b', NOW)).resolves.toEqual({
      state: 'none',
      canRequest: false,
      reason: 'cooldown',
      until: new Date(declinedAt.getTime() + 30 * DAY).toISOString(),
    });
    await expect(h.views.relation(D, 'member-a', NOW)).resolves.toEqual({
      state: 'none',
      canRequest: false,
      reason: 'limit',
    });
    await expect(h.views.relation(C, 'member-b', NOW)).resolves.toEqual({
      state: 'none',
      canRequest: false,
      reason: 'private-needs-public',
    });
  });
});

describe('ConnectionsService.overview and settings', () => {
  it('lists incoming, outgoing, connected and blocked, naming members only as far as allowed', async () => {
    const h = harness({
      connections: [
        row(C, A, { note: 'from a private member' }),
        row(A, B, { note: 'mine' }),
        row(D, A, { status: 'accepted' }),
        row(A, 'user_x', { status: 'declined', live: undefined }),
        row(G, A),
      ],
      blocks: [
        { blockerUserId: A, blockedUserId: H, createdAt: NOW },
        { blockerUserId: B, blockedUserId: A, createdAt: NOW },
      ],
      settings: [{ userId: A, openTo: 'public-members', contacts: [] }],
    });
    const view = await h.views.overview(A);
    expect(view.terms).toEqual(DEFAULT_TERMS);
    expect(view.me).toEqual({
      eligible: true,
      visibility: 'public',
      openTo: 'public-members',
      openToChosen: true,
      contacts: [],
      pendingSent: 1,
      maxPendingSent: 20,
    });
    // The Private member is named (they chose to write) but not linked.
    expect(view.incoming).toEqual([
      {
        id: String(h.connections.docs[0]._id),
        member: { name: 'Member C' },
        note: 'from a private member',
        sentAt: NOW.toISOString(),
      },
    ]);
    expect(view.outgoing).toEqual([
      {
        id: String(h.connections.docs[1]._id),
        member: { name: 'Member B', slug: 'member-b' },
        note: 'mine',
        sentAt: NOW.toISOString(),
      },
    ]);
    expect(view.connected).toEqual([
      {
        id: String(h.connections.docs[2]._id),
        member: { name: 'Member D', slug: 'member-d' },
        since: NOW.toISOString(),
        contacts: [{ method: 'telegram', value: '@member-d-page' }],
      },
    ]);
    // Only the block A made; never the one made against A.
    expect(view.blocked).toEqual([
      {
        id: String(h.blocks.docs[0]._id),
        member: { name: 'Member H', slug: 'member-h' },
        since: NOW.toISOString(),
      },
    ]);
  });

  it('says so to a member without a page, and lists nothing', async () => {
    const view = await harness().views.overview(NOBODY);
    expect(view.me).toEqual({
      eligible: false,
      openTo: 'nobody',
      openToChosen: false,
      contacts: [],
      pendingSent: 0,
      maxPendingSent: 20,
    });
    expect(view.incoming).toEqual([]);
  });

  it('defaults "open to" from the page’s visibility now, until the member chooses', async () => {
    const h = harness();
    expect((await h.views.overview(C)).me.openTo).toBe('nobody');
    h.profiles.docs.find((p) => p.ownerUserId === C)!.visibility = 'public';
    expect((await h.views.overview(C)).me.openTo).toBe('any-member');
    await h.service.updateSettings(C, { openTo: 'public-members' });
    h.profiles.docs.find((p) => p.ownerUserId === C)!.visibility = 'unlisted';
    const me = (await h.views.overview(C)).me;
    expect([me.openTo, me.openToChosen]).toEqual(['public-members', true]);
  });

  it('saves connections-only contact rows, cleaned, and refuses an unknown member', async () => {
    const h = harness();
    await expect(
      h.service.updateSettings(A, {
        contacts: [
          { method: 'email', value: '  a@example.org ' },
          { method: 'phone', value: ' ​ ' },
        ],
      }),
    ).resolves.toEqual({
      openTo: 'any-member',
      openToChosen: false,
      contacts: [{ method: 'email', value: 'a@example.org' }],
    });
    await expect(
      refusal(
        h.service.updateSettings(A, {
          contacts: [{ method: 'other', value: 'x'.repeat(201) }],
        }),
      ),
    ).resolves.toEqual({ status: 400, message: M.contactTooLong });
    await expect(
      refusal(h.service.updateSettings(NOBODY, { openTo: 'nobody' })),
    ).resolves.toEqual({ status: 403, message: M.noPage });
  });
});

describe('ConnectionsService races and edges', () => {
  it('sees a block that lands while the request is being written', async () => {
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
    expect(h.connections.docs).toHaveLength(0);
  });

  it('answers a decline, withdrawal or disconnect that lost a race as a conflict', async () => {
    for (const [status, act] of [
      ['pending', 'decline'],
      ['pending', 'withdraw'],
      ['accepted', 'disconnect'],
    ] as const) {
      const h = harness({
        connections: [row(A, B, { status })],
        beforeConnectionWrite: (operation) => {
          if (operation === 'updateOne') h.connections.docs[0].status = 'ended';
        },
      });
      const who = act === 'decline' ? B : A;
      await expect(
        refusal(h.service[act](who, String(h.connections.docs[0]._id), NOW)),
      ).resolves.toEqual({ status: 409, message: M.changed });
    }
  });

  it('works on the server clock when no time is given', async () => {
    const h = harness({ connections: [row(D, A), row(B, D)] });
    const sent = await h.service.send(A, 'member-b');
    expect(h.connections.docs[2].createdAt).toBeInstanceOf(Date);
    await h.service.accept(A, String(h.connections.docs[0]._id));
    expect(h.connections.docs[0].decidedAt).toBeInstanceOf(Date);
    await h.service.disconnect(A, String(h.connections.docs[0]._id));
    await h.service.withdraw(A, sent.id);
    await h.service.decline(D, String(h.connections.docs[1]._id));
    await h.service.block(A, { slug: 'member-d' });
    await expect(h.views.relation(A, 'member-b')).resolves.toBeDefined();
    expect(h.connections.docs.map((r) => r.status)).toEqual([
      'ended',
      'declined',
      'withdrawn',
    ]);
  });

  it('blocks through a request the member sent, too', async () => {
    const h = harness({ connections: [row(A, B)] });
    await h.service.block(A, {
      connectionId: String(h.connections.docs[0]._id),
    });
    expect(h.blocks.docs[0]).toMatchObject({
      blockerUserId: A,
      blockedUserId: B,
    });
  });

  it('shares no contacts with a member whose account is gone, or while the reader lost their page', async () => {
    const h = harness({
      connections: [
        row(A, H, { status: 'accepted' }),
        row(F, A, { status: 'accepted' }),
      ],
    });
    // Nothing is live with a member whose account is gone (review round 4):
    // the button gives the refusal, as the send does, and no contacts.
    await expect(h.views.relation(A, 'member-h', NOW)).resolves.toEqual({
      state: 'none',
      canRequest: false,
      reason: 'not-open',
    });
    const view = await h.views.overview(F);
    expect(view.me.eligible).toBe(false);
    expect(view.connected).toEqual([
      expect.objectContaining({
        member: { name: 'Member A', slug: 'member-a' },
        contacts: [],
      }),
    ]);
  });

  it('leaves out a received note a moderator hid', async () => {
    const h = harness({
      connections: [row(B, A, { note: 'hidden', noteHiddenAt: NOW })],
    });
    const view = await h.views.overview(A);
    expect(view.incoming[0]).not.toHaveProperty('note');
  });

  it('changes nothing for an empty settings save', async () => {
    const h = harness();
    await expect(h.service.updateSettings(A, {})).resolves.toEqual({
      openTo: 'any-member',
      openToChosen: false,
      contacts: [],
    });
    expect(h.settings.docs).toHaveLength(0);
  });
});
