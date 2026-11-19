import { Types } from 'mongoose';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { FORMER_MEMBER } from './connection-records.service';
import { pairKeyOf } from './connection-rules';
import {
  A,
  B,
  C,
  D,
  G,
  NOW,
  recordsOver,
  seedPages,
} from './connections-harness.mocks-spec';

const SESSION = {} as never;
const READER = { kind: 'named-member' as const, userId: A, isAdmin: false };

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

function build(seed: Parameters<typeof recordsOver>[1] = {}) {
  const profiles = fakeModel(seedPages());
  return { profiles, ...recordsOver(profiles, seed) };
}

describe('ConnectionRecords.endAllFor', () => {
  it('ends every live request and connection of the member, and nothing else', async () => {
    const h = build({
      connections: [
        row(A, B),
        row(C, A, { status: 'accepted' }),
        row(A, D, { status: 'declined', live: undefined }),
        row(B, D),
      ],
    });
    await h.records.endAllFor(A, NOW, SESSION);
    expect(
      h.connections.docs.map((r) => [r.status, r.live, r.endReason]),
    ).toEqual([
      ['ended', undefined, 'page-deleted'],
      ['ended', undefined, 'page-deleted'],
      ['declined', undefined, undefined],
      ['pending', true, undefined],
    ]);
    await h.records.endAllFor(B, NOW);
    expect(h.connections.docs[3].status).toBe('ended');
  });
});

describe('ConnectionRecords purge', () => {
  const seed = () => ({
    connections: [row(A, B), row(C, A), row(B, D)],
    blocks: [
      { blockerUserId: A, blockedUserId: D },
      { blockerUserId: D, blockedUserId: A },
      { blockerUserId: B, blockedUserId: D },
    ],
    settings: [{ userId: A, openTo: 'nobody' }, { userId: B }],
  });

  it('for a page: the member’s records and own blocks; blocks against them stay', async () => {
    const h = build(seed());
    await h.records.purgeForPage(A);
    expect(h.connections.docs).toHaveLength(1);
    expect(h.blocks.docs.map((b) => b.blockerUserId)).toEqual([D, B]);
    expect(h.settings.docs.map((s) => s.userId)).toEqual([B]);
  });

  it('for an account: every record naming the person', async () => {
    const h = build(seed());
    await h.records.purgeForAccount(A);
    expect(h.blocks.docs.map((b) => b.blockerUserId)).toEqual([B]);
  });
});

describe('ConnectionRecords.exportFor', () => {
  it('holds the member’s settings, connections, requests and only their own blocks', async () => {
    const h = build({
      connections: [
        row(A, B, { note: 'sent note' }),
        row(C, A, { note: 'received note' }),
        row(D, A, { note: 'hidden note', noteHiddenAt: NOW }),
        row(A, G, {
          status: 'accepted',
          decidedAt: NOW,
        }),
        row(B, A, { status: 'accepted', live: undefined, pairKey: 'old' }),
        // A connection (it was accepted) that one of them ended.
        row(A, 'user_x', {
          status: 'ended',
          live: undefined,
          decidedAt: NOW,
          endedAt: NOW,
          endReason: 'disconnect',
        }),
      ],
      blocks: [
        { blockerUserId: A, blockedUserId: D, createdAt: NOW },
        { blockerUserId: B, blockedUserId: A, createdAt: NOW },
      ],
      settings: [
        {
          userId: A,
          openTo: 'public-members',
          contacts: [{ method: 'email', value: 'a@example.org' }],
        },
      ],
    });
    const data = await h.records.exportFor(A, READER);
    expect(data.settings).toEqual({
      openTo: 'public-members',
      contactsForConnections: [{ method: 'email', value: 'a@example.org' }],
    });
    expect(data.connected).toEqual([
      { member: { name: FORMER_MEMBER }, since: NOW.toISOString() },
      {
        member: { name: 'Member B', slug: 'member-b' },
        since: NOW.toISOString(),
      },
    ]);
    expect(data.requestsSent).toEqual([
      {
        to: { name: 'Member B', slug: 'member-b' },
        status: 'pending',
        note: 'sent note',
        sentAt: NOW.toISOString(),
      },
      {
        to: { name: FORMER_MEMBER },
        status: 'accepted',
        sentAt: NOW.toISOString(),
        answeredAt: NOW.toISOString(),
      },
      {
        to: { name: FORMER_MEMBER },
        status: 'ended',
        sentAt: NOW.toISOString(),
        endedAt: NOW.toISOString(),
      },
    ]);
    // A Private member is named but not linked; a hidden note is left out.
    expect(data.requestsReceived).toEqual([
      {
        from: { name: 'Member C' },
        status: 'pending',
        note: 'received note',
        receivedAt: NOW.toISOString(),
      },
      {
        from: { name: 'Member D', slug: 'member-d' },
        status: 'pending',
        receivedAt: NOW.toISOString(),
      },
      {
        from: { name: 'Member B', slug: 'member-b' },
        status: 'accepted',
        receivedAt: NOW.toISOString(),
      },
    ]);
    expect(data.blocksMade).toEqual([
      {
        member: { name: 'Member D', slug: 'member-d' },
        since: NOW.toISOString(),
      },
    ]);
  });

  it('says the default when the member never chose', async () => {
    const data = await build().records.exportFor(A, READER);
    expect(data.settings).toEqual({
      openTo: 'default for your page',
      contactsForConnections: [],
    });
    expect(data.requestsSent).toEqual([]);
  });
});

describe('ConnectionRecords notes (moderation)', () => {
  it('lets only the recipient report a shown note', async () => {
    const h = build({
      connections: [
        row(B, A, { note: 'a note' }),
        row(B, D),
        row(B, C, { note: 'gone', noteHiddenAt: NOW }),
        row('user_nopage', A, { note: 'orphan' }),
      ],
    });
    const [withNote, noNote, hidden, orphan] = h.connections.docs.map((r) =>
      String(r._id),
    );
    await expect(h.records.noteTarget(A, withNote)).resolves.toEqual({
      kind: 'ok',
      targetId: withNote,
      targetProfileId: h.profiles.docs[1]._id,
      subjectUserId: B,
    });
    await expect(h.records.noteTarget(B, withNote)).resolves.toEqual({
      kind: 'own',
    });
    await expect(h.records.noteTarget(C, withNote)).resolves.toEqual({
      kind: 'not-found',
    });
    await expect(h.records.noteTarget(D, noNote)).resolves.toEqual({
      kind: 'not-reportable',
    });
    await expect(h.records.noteTarget(C, hidden)).resolves.toEqual({
      kind: 'not-reportable',
    });
    await expect(h.records.noteTarget(A, orphan)).resolves.toEqual({
      kind: 'not-reportable',
    });
    for (const id of ['nope', String(new Types.ObjectId())]) {
      await expect(h.records.noteTarget(A, id)).resolves.toEqual({
        kind: 'not-found',
      });
    }
  });

  it('shows admins the note and both members, and hides it once', async () => {
    const h = build({
      connections: [row(B, A, { note: 'a note' }), row('user_nopage', A)],
    });
    const [id, orphan] = h.connections.docs.map((r) => String(r._id));
    await expect(h.records.noteViews([])).resolves.toEqual(new Map());
    await expect(h.records.noteViews(['bad'])).resolves.toEqual(new Map());
    const views = await h.records.noteViews([id, orphan]);
    expect(views.get(id)).toEqual({
      note: 'a note',
      hidden: false,
      status: 'pending',
      sentAt: NOW.toISOString(),
      sender: { slug: 'member-b', displayName: 'Member B', ownerUserId: B },
      recipient: { slug: 'member-a', displayName: 'Member A', ownerUserId: A },
    });
    expect(views.get(orphan)).toMatchObject({
      note: '',
      sender: { slug: '', displayName: FORMER_MEMBER },
    });
    await expect(h.records.senderOf(id, SESSION)).resolves.toBe(B);
    await expect(h.records.senderOf(id)).resolves.toBe(B);
    await expect(h.records.senderOf('bad')).resolves.toBeUndefined();
    await expect(
      h.records.senderOf(String(new Types.ObjectId())),
    ).resolves.toBeUndefined();
    await expect(h.records.hideNote(id, NOW, SESSION)).resolves.toBe(true);
    await expect(h.records.hideNote(id, NOW, SESSION)).resolves.toBe(false);
    await expect(h.records.hideNote('bad', NOW, SESSION)).resolves.toBe(false);
    expect((await h.records.noteViews([id])).get(id)?.hidden).toBe(true);
  });
});

describe('ConnectionRecords.pagesOf', () => {
  it('asks nothing for no one', async () => {
    const h = build();
    await expect(h.records.pagesOf([])).resolves.toEqual(new Map());
  });
});
