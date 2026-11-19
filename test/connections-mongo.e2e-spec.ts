/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
// Connection requests (Chunk 18) against a REAL MongoDB replica set: the
// partial unique index that holds ONE live record per pair under concurrent
// and crossed requests, the pending cap under a burst, block secrecy, contact
// sharing that never reaches admin-only backup contacts, and the ending,
// export and purge that come with "Delete my page". Needs MONGO_TEST_URI (a
// throwaway replica-set database; it is dropped). Without it the suite is
// SKIPPED, never passed. Synthetic data only.
import { HttpException } from '@nestjs/common';
import mongoose, { type Model, Types } from 'mongoose';
import { ConnectionLookups } from '../src/connections/connection-lookups.service';
import { messagesFor } from '../src/connections/connection-messages';
import { ConnectionRecords } from '../src/connections/connection-records.service';
import {
  ConnectionTermsService,
  DEFAULT_TERMS,
} from '../src/connections/connection-terms.service';
import { ConnectionViews } from '../src/connections/connection-views.service';
import { pairKeyOf } from '../src/connections/connection-rules';
import { ConnectionsService } from '../src/connections/connections.service';
import { MANAGED_SCHEMAS } from '../src/db/managed-schemas';
import { PageDeletionService } from '../src/member-data/page-deletion.service';
import { ModerationLogService } from '../src/moderation/moderation-log.service';

const uri = process.env.MONGO_TEST_URI;
const describeWithMongo = uri ? describe : describe.skip;
const M = messagesFor(DEFAULT_TERMS);

const A = 'user_member_a';
const B = 'user_member_b';
const C = 'user_member_c';
const BACKUP_MARKER = 'backup-only-marker.example';

async function outcome(promise: Promise<unknown>) {
  try {
    const value = (await promise) as { status: string };
    return value.status;
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
}

/** The refusal a promise ends in, as status and words. */
async function refusal(promise: Promise<unknown>) {
  const error = (await promise.then(
    () => undefined,
    (e: unknown) => e,
  )) as HttpException;
  return [error.getStatus(), error.message] as const;
}

describeWithMongo('connection requests on a real MongoDB', () => {
  jest.setTimeout(120_000);
  let conn: mongoose.Connection;
  const m = {} as Record<string, Model<any>>;
  let service: ConnectionsService;
  let views: ConnectionViews;
  let records: ConnectionRecords;
  let deletion: PageDeletionService;
  const notifier = {
    connectionRequested: jest.fn(() => Promise.resolve()),
    connectionAccepted: jest.fn(() => Promise.resolve()),
  };

  const page = (userId: string, slug: string, visibility = 'public') => ({
    _id: new Types.ObjectId(),
    slug,
    displayName: `Name ${slug}`,
    visibility,
    reviewStatus: 'approved',
    anonymous: false,
    ownerUserId: userId,
    contacts: [{ method: 'telegram', value: `@${slug}` }],
    source: 'native',
    imageIds: [],
    createdAt: new Date(),
  });

  beforeAll(async () => {
    conn = await mongoose.createConnection(String(uri)).asPromise();
    await conn.dropDatabase();
    for (const { name, schema } of MANAGED_SCHEMAS) {
      m[name] = conn.model(name, schema);
      await m[name].createCollection();
      await m[name].createIndexes();
    }
    const log = new ModerationLogService(m.ModerationLogEntry);
    records = new ConnectionRecords(
      m.MemberConnection,
      m.ConnectionBlock,
      m.ConnectionSettings,
      m.SocialProfile,
    );
    const lookups = new ConnectionLookups(
      m.MemberConnection,
      m.ConnectionBlock,
      m.ConnectionSettings,
      m.SocialProfile,
      m.AccountDeletion,
      records,
      new ConnectionTermsService(m.OrgSetting, log),
    );
    service = new ConnectionsService(
      conn,
      m.MemberConnection,
      m.ConnectionBlock,
      m.ConnectionSettings,
      lookups,
      notifier as never,
    );
    views = new ConnectionViews(
      m.MemberConnection,
      m.ConnectionBlock,
      records,
      lookups,
    );
    deletion = new PageDeletionService(
      conn,
      m.SocialProfile,
      m.NotificationQueueRow,
      log,
      m.AccountDeletion,
      m.Comment,
      m.CommentVersion,
      m.UserWriteGate,
      records,
    );
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  beforeEach(async () => {
    for (const name of [
      'SocialProfile',
      'MemberConnection',
      'ConnectionBlock',
      'ConnectionSettings',
      'MemberContacts',
      // A forced account deletion must not leak into the next test.
      'AccountDeletion',
      'UserWriteGate',
    ]) {
      await m[name].deleteMany({});
    }
    await m.SocialProfile.collection.insertMany([
      page(A, 'member-a'),
      page(B, 'member-b', 'members'),
      page(C, 'member-c', 'unlisted'),
    ]);
    notifier.connectionRequested.mockClear();
    notifier.connectionAccepted.mockClear();
  });

  it('declares the partial unique index on the pair key', async () => {
    const indexes = await m.MemberConnection.collection.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { pairKey: 1 },
          unique: true,
          partialFilterExpression: { live: true },
        }),
      ]),
    );
  });

  it('holds ONE live record when the same request is sent many times at once', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        outcome(service.send(A, 'member-b', undefined)),
      ),
    );
    expect(results.filter((r) => r === 'pending')).toHaveLength(1);
    expect(results.filter((r) => r === 409)).toHaveLength(7);
    expect(
      await m.MemberConnection.countDocuments({ pairKey: pairKeyOf(A, B) }),
    ).toBe(1);
  });

  it('turns crossed requests sent at once into one connection', async () => {
    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => outcome(service.send(A, 'member-b'))),
      ...Array.from({ length: 4 }, () => outcome(service.send(B, 'member-a'))),
    ]);
    const rows = await m.MemberConnection.find({
      pairKey: pairKeyOf(A, B),
    }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].live).toBe(true);
    // The first request is pending; a crossing one accepts it.
    expect(results).toContain('pending');
    if (rows[0].status === 'accepted') expect(results).toContain('accepted');
    for (const r of results) expect(['pending', 'accepted', 409]).toContain(r);
  });

  it('keeps the 20-request cap under a burst of sends to different members', async () => {
    const extra = Array.from({ length: 25 }, (_, n) =>
      page(`user_extra_${n}`, `extra-member-${n}`),
    );
    await m.SocialProfile.collection.insertMany(extra);
    const results = await Promise.all(
      extra.map((p) => outcome(service.send(A, p.slug))),
    );
    expect(results.filter((r) => r === 'pending')).toHaveLength(20);
    expect(results.filter((r) => r === 429)).toHaveLength(5);
    expect(
      await m.MemberConnection.countDocuments({
        fromUserId: A,
        status: 'pending',
      }),
    ).toBe(20);
  });

  it('lets a pair ask again after a withdrawal, keeping the old record', async () => {
    const first = await service.send(A, 'member-b');
    await service.withdraw(A, first.id);
    await service.send(A, 'member-b');
    expect(
      await m.MemberConnection.find({ pairKey: pairKeyOf(A, B) })
        .sort({ createdAt: 1 })
        .lean()
        .then((rows) => rows.map((r) => [r.status, r.live])),
    ).toEqual([
      ['withdrawn', undefined],
      ['pending', true],
    ]);
  });

  it('answers a blocked member exactly like a closed one, and never says Private pages exist', async () => {
    await m.ConnectionSettings.create({ userId: B, openTo: 'nobody' });
    const closed = await refusal(service.send(A, 'member-b'));
    await m.ConnectionSettings.deleteMany({});
    await service.block(B, { slug: 'member-a' });
    const blocked = await refusal(service.send(A, 'member-b'));
    expect(blocked).toEqual(closed);
    expect(blocked).toEqual([403, M.notOpen]);
    const hidden = await refusal(service.send(A, 'member-c'));
    const missing = await refusal(service.send(A, 'no-such-page'));
    expect(hidden).toEqual(missing);
    expect(hidden).toEqual([404, M.pageNotFound]);
  });

  it('shares contact rows with a connection only, never the admin-only backup contacts', async () => {
    await m.MemberContacts.create({
      userId: B,
      backup: [{ method: 'email', value: BACKUP_MARKER }],
    });
    await m.ConnectionSettings.create({
      userId: B,
      contacts: [{ method: 'signal', value: 'b-for-connections.example' }],
    });
    const sent = await service.send(A, 'member-b');
    const before = JSON.stringify(await views.relation(A, 'member-b'));
    expect(before).not.toContain('b-for-connections.example');
    await service.accept(B, sent.id);
    const relation = await views.relation(A, 'member-b');
    expect(relation).toMatchObject({
      state: 'connected',
      contacts: [
        { method: 'telegram', value: '@member-b' },
        { method: 'signal', value: 'b-for-connections.example' },
      ],
    });
    const all = JSON.stringify([
      relation,
      await views.overview(A),
      await views.overview(B),
      await records.exportFor(A, {
        kind: 'named-member',
        userId: A,
        isAdmin: false,
      }),
    ]);
    expect(all).not.toContain(BACKUP_MARKER);
    await service.disconnect(B, sent.id);
    expect(JSON.stringify(await views.relation(A, 'member-b'))).not.toContain(
      'b-for-connections.example',
    );
  });

  it('never reaches a Private page, even one open to any member (review round 1)', async () => {
    await m.ConnectionSettings.create({ userId: C, openTo: 'any-member' });
    expect(await refusal(service.send(A, 'member-c'))).toEqual(
      await refusal(service.send(A, 'no-such-page')),
    );
    expect(await m.MemberConnection.countDocuments({})).toBe(0);
  });

  it('expires a request unanswered for 90 days, freeing the pair (review round 1)', async () => {
    await m.MemberConnection.collection.insertOne({
      fromUserId: A,
      toUserId: B,
      pairKey: pairKeyOf(A, B),
      status: 'pending',
      live: true,
      createdAt: new Date(Date.now() - 91 * 24 * 60 * 60_000),
    });
    await expect(service.send(A, 'member-b')).resolves.toMatchObject({
      status: 'pending',
    });
    const rows = await m.MemberConnection.find({ pairKey: pairKeyOf(A, B) })
      .sort({ createdAt: 1 })
      .lean();
    expect(rows.map((r) => [r.status, r.live])).toEqual([
      ['expired', undefined],
      ['pending', true],
    ]);
  });

  it('tells a blocked Private requester the Private rule, as before the block (review round 2)', async () => {
    // C is Private; B's page is members-only.
    const before = await refusal(service.send(C, 'member-b'));
    const buttonBefore = await views.relation(C, 'member-b');
    await m.ConnectionBlock.create({ blockerUserId: B, blockedUserId: C });
    expect(await refusal(service.send(C, 'member-b'))).toEqual(before);
    expect(await views.relation(C, 'member-b')).toEqual(buttonBefore);
    expect(before).toEqual([403, M.privateNeedsPublic]);
    expect(buttonBefore).toMatchObject({ reason: 'private-needs-public' });
  });

  it('survives first sends racing to create the sender’s gate row (review round 2)', async () => {
    const extra = Array.from({ length: 10 }, (_, n) =>
      page(`user_gate_${n}`, `gate-member-${n}`),
    );
    await m.SocialProfile.collection.insertMany(extra);
    expect(await m.ConnectionSettings.countDocuments({ userId: A })).toBe(0);
    const results = await Promise.all(
      extra.map((p) => outcome(service.send(A, p.slug))),
    );
    expect(results).toEqual(extra.map(() => 'pending'));
    expect(await m.ConnectionSettings.countDocuments({ userId: A })).toBe(1);
    const indexes = await m.ConnectionSettings.collection.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { userId: 1 }, unique: true }),
      ]),
    );
  });

  it('sweeps expired requests through an index, not a collection scan (review round 2)', async () => {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60_000);
    const plan = (await m.MemberConnection.find({
      status: 'pending',
      live: true,
      createdAt: { $lte: cutoff },
    }).explain('queryPlanner')) as unknown as {
      queryPlanner: { winningPlan: unknown };
    };
    const text = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(text).toContain('IXSCAN');
    expect(text).not.toContain('COLLSCAN');
    expect(text).toContain('"createdAt":1');
  });

  it('makes a block of a waiting request read as a decline to its sender (review round 3)', async () => {
    const sent = await service.send(A, 'member-b');
    await service.block(B, { connectionId: sent.id });
    expect(await views.relation(A, 'member-b')).toMatchObject({
      reason: 'cooldown',
    });
    expect(await m.MemberConnection.findOne({}).lean()).toMatchObject({
      status: 'declined',
      endReason: 'block',
    });
  });

  it('expires a stale, unswept request before a block can end it (review round 4)', async () => {
    await m.MemberConnection.collection.insertOne({
      fromUserId: A,
      toUserId: B,
      pairKey: pairKeyOf(A, B),
      status: 'pending',
      live: true,
      createdAt: new Date(Date.now() - 100 * 24 * 60 * 60_000),
    });
    await service.block(B, { slug: 'member-a' });
    expect(await m.MemberConnection.findOne({}).lean()).toMatchObject({
      status: 'expired',
    });
    expect(await views.relation(A, 'member-b')).toMatchObject({
      reason: 'not-open',
    });
  });

  it('never leaves a request alive when it races "Delete my page" of its recipient (review round 5)', async () => {
    // Forced interleaving: the send has started its transaction and taken
    // its snapshot; it waits while B deletes their page, then inserts.
    const lookups = (service as unknown as { lookups: ConnectionLookups })
      .lookups;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with .apply on the same object, and restored
    const original = lookups.pendingSent;
    let entered: () => void = () => undefined;
    const inSend = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let paused = false;
    lookups.pendingSent = async (...args) => {
      if (!paused) {
        paused = true;
        entered();
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      return original.apply(lookups, args);
    };
    try {
      const sending = outcome(service.send(A, 'member-b'));
      await inSend;
      await deletion.deleteOwn(B, 'member-b');
      await sending;
    } finally {
      lookups.pendingSent = original;
    }
    expect(
      await m.MemberConnection.countDocuments({
        live: true,
        $or: [{ fromUserId: B }, { toUserId: B }],
      }),
    ).toBe(0);
  });

  it('refuses a send that races a deletion already under way (review round 5)', async () => {
    // Forced interleaving the other way: the deletion's transaction has
    // written B's gate row and waits; the send runs meanwhile.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with .apply on the same object, and restored
    const original = records.endAllFor;
    let entered: () => void = () => undefined;
    const inDeletion = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let paused = false;
    records.endAllFor = async (...args) => {
      await original.apply(records, args);
      if (!paused) {
        paused = true;
        entered();
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    };
    try {
      const deleting = deletion.deleteOwn(B, 'member-b');
      await inDeletion;
      const answer = await outcome(service.send(A, 'member-b'));
      await deleting;
      expect([403, 404]).toContain(answer);
    } finally {
      records.endAllFor = original;
    }
    expect(
      await m.MemberConnection.countDocuments({
        live: true,
        $or: [{ fromUserId: B }, { toUserId: B }],
      }),
    ).toBe(0);
  });

  describe('every write that makes a row live re-checks both members inside its transaction (review round 6)', () => {
    type Kind = 'deleteOwn' | 'accountDeleted';
    const slugOf: Record<string, string> = { [A]: 'member-a', [B]: 'member-b' };
    const remove = async (userId: string, kind: Kind) => {
      if (kind === 'deleteOwn')
        await deletion.deleteOwn(userId, slugOf[userId]);
      else await deletion.accountDeleted(userId);
    };
    const pending = (from: string, to: string) =>
      m.MemberConnection.collection.insertOne({
        fromUserId: from,
        toUserId: to,
        pairKey: pairKeyOf(from, to),
        status: 'pending',
        live: true,
        createdAt: new Date(),
      });

    /**
     * The write paths that create or revive a live row, each with the last
     * step it takes BEFORE its transaction: the forced deletion runs there,
     * to completion.
     */
    const PATHS: Array<{
      name: string;
      parties: { acting: string; other: string };
      setup: () => Promise<unknown>;
      hook: () => { on: Record<string, unknown>; method: string };
      run: () => Promise<unknown>;
    }> = [
      {
        name: 'send',
        parties: { acting: A, other: B },
        setup: () => Promise.resolve(),
        hook: () => ({
          on: (service as unknown as { lookups: Record<string, unknown> })
            .lookups,
          method: 'refusalOf',
        }),
        run: () => service.send(A, 'member-b'),
      },
      {
        name: 'send that crosses a waiting request (auto-accept)',
        parties: { acting: A, other: B },
        setup: () => pending(B, A),
        hook: () => ({
          on: service as unknown as Record<string, unknown>,
          method: 'stillAllowed',
        }),
        run: () => service.send(A, 'member-b'),
      },
      {
        name: 'accept',
        parties: { acting: A, other: B },
        setup: () => pending(B, A),
        hook: () => ({
          on: service as unknown as Record<string, unknown>,
          method: 'stillAllowed',
        }),
        run: async () => {
          const row = (await m.MemberConnection.findOne({
            live: true,
          }).lean()) as { _id: unknown } | null;
          return service.accept(A, String(row!._id));
        },
      },
    ];

    for (const path of PATHS) {
      for (const who of ['acting', 'other'] as const) {
        for (const kind of ['deleteOwn', 'accountDeleted'] as const) {
          it(`${path.name}: ${who} member removed by ${kind} just before the transaction`, async () => {
            await path.setup();
            const victim = path.parties[who];
            const { on, method } = path.hook();
            const original = on[method] as (
              ...a: unknown[]
            ) => Promise<unknown>;
            let fired = false;
            on[method] = async (...args: unknown[]) => {
              const answer: unknown = await original.apply(on, args);
              if (!fired) {
                fired = true;
                await remove(victim, kind);
              }
              return answer;
            };
            let answer: unknown;
            try {
              answer = await outcome(path.run());
            } finally {
              on[method] = original;
            }
            expect(fired).toBe(true);
            expect([403, 404]).toContain(answer);
            expect(
              await m.MemberConnection.countDocuments({
                live: true,
                $or: [{ fromUserId: victim }, { toUserId: victim }],
              }),
            ).toBe(0);
            if (kind === 'deleteOwn') {
              // An undo brings the page back, never the request.
              await deletion.undoOwn(victim);
              expect(
                await m.MemberConnection.countDocuments({ live: true }),
              ).toBe(0);
            }
          });
        }
      }
    }
  });

  it('an undo within the window brings the page back, never a request or a connection (review round 6)', async () => {
    const C2 = 'user_member_d';
    await m.SocialProfile.collection.insertOne(page(C2, 'member-d'));
    await service.send(A, 'member-b');
    const asked = await service.send(C2, 'member-a');
    await service.accept(A, asked.id);
    await deletion.deleteOwn(A, 'member-a');
    await deletion.undoOwn(A);
    expect(await m.MemberConnection.countDocuments({ live: true })).toBe(0);
    const statuses = (await m.MemberConnection.find({}).lean()) as Array<{
      status: string;
    }>;
    expect(statuses.map((row) => row.status).sort()).toEqual([
      'ended',
      'ended',
    ]);
    const overview = JSON.stringify(await views.overview(A));
    expect(overview).not.toContain('member-b');
    expect(overview).not.toContain('member-d');
    expect(await views.relation(A, 'member-b')).not.toMatchObject({
      status: 'pending',
    });
    // Anything new needs a new request, which works again.
    await expect(service.send(A, 'member-b')).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('ends everything with "Delete my page", and the purge removes the records', async () => {
    const sent = await service.send(A, 'member-b');
    await service.accept(B, sent.id);
    // A Private member may send to a Public one.
    await service.send(C, 'member-a');
    await deletion.deleteOwn(A, 'member-a');
    const rows = await m.MemberConnection.find({}).lean();
    expect(rows.map((r) => [r.status, r.live, r.endReason])).toEqual([
      ['ended', undefined, 'page-deleted'],
      ['ended', undefined, 'page-deleted'],
    ]);
    // B no longer sees A's contacts, or A at all.
    expect(JSON.stringify(await views.overview(B))).not.toContain('member-a');
    const exported = await records.exportFor(A, {
      kind: 'signed-in',
      userId: A,
      isAdmin: false,
    });
    expect(exported.requestsSent).toHaveLength(1);
    expect(exported.requestsReceived).toEqual([
      expect.objectContaining({ status: 'closed' }),
    ]);
    await records.purgeForAccount(A);
    expect(await m.MemberConnection.countDocuments({})).toBe(0);
  });
});
