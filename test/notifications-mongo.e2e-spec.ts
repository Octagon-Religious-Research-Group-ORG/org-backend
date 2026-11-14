/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- real Mongo rows */
// Member notifications (Chunk 14) against a REAL MongoDB replica set: the
// indexes, one email per member per day even with two server instances
// racing, one immediate email per notice under two ticks, the daily budget
// under parallel sends, one queued notice per event, and the transaction
// that marks a digest and its items sent together. Needs MONGO_TEST_URI (a
// throwaway replica-set database; it is dropped). Without it the suite is
// reported as SKIPPED, never as passed. No email is sent: the sender is a
// stub. Synthetic data only.
import { Logger } from '@nestjs/common';
import mongoose, { type Model, Types } from 'mongoose';
import { AdminInboxEntrySchema } from '../src/admin-inbox/schemas/admin-inbox.schema';
import { WebsitePageSchema } from '../src/content/schemas/website-page.schema';
import { MANAGED_SCHEMAS } from '../src/db/managed-schemas';
import { DigestSender } from '../src/member-notifications/digest-sender';
import { EmailBudgetStore } from '../src/member-notifications/email-budget.store';
import { MemberNotifier } from '../src/member-notifications/member-notifier.service';
import { NotificationDispatcher } from '../src/member-notifications/notification-dispatcher.service';
import { NotificationPrefsService } from '../src/member-notifications/notification-prefs.service';
import { NotificationTargets } from '../src/member-notifications/notification-targets.service';

const uri = process.env.MONGO_TEST_URI;
const describeWithMongo = uri ? describe : describe.skip;

const NOW = new Date('2026-11-13T15:00:00Z');
const PAGE = new Types.ObjectId();
const VALUES: Record<string, unknown> = {
  PUBLIC_APP_URL: 'https://org.example.test',
  CLERK_SECRET_KEY: 'sk_test_synthetic',
  EMAIL_DAILY_LIMIT: 5,
  EMAIL_IMMEDIATE_RESERVE: 2,
  DIGEST_HOUR_UTC: 14,
};
const config = {
  get: (key: string) => VALUES[key],
  getOrThrow: (key: string) => VALUES[key],
} as never;

describeWithMongo('member notifications on a real MongoDB', () => {
  jest.setTimeout(60_000);
  let conn: mongoose.Connection;
  const m = {} as Record<string, Model<any>>;
  let prefs: NotificationPrefsService;
  let budget: EmailBudgetStore;
  let targets: NotificationTargets;
  const sent: Array<{ to: string; idempotencyKey: string; lines: string[] }> =
    [];
  // Slow enough that two instances overlap while one is "sending".
  const mail = {
    noticesEnabled: () => true,
    sendNotice: jest.fn(
      async (message: {
        to: string;
        idempotencyKey: string;
        lines: string[];
      }) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        sent.push(message);
        return 'sent' as const;
      },
    ),
  };
  const digestSender = () =>
    new DigestSender(
      m.NotificationQueueRow,
      m.NotificationDigestRow,
      conn,
      config,
      prefs,
      targets,
      budget,
      mail as never,
    );
  const dispatcher = () =>
    new NotificationDispatcher(
      m.NotificationQueueRow,
      m.AdminInboxEntry,
      config,
      prefs,
      targets,
      budget,
      mail as never,
      digestSender(),
      {
        holdersOf: () =>
          Promise.resolve({
            holders: [{ userId: 'user_admin' }],
            complete: true,
          }),
        usersByEmail: () => Promise.resolve([]),
      } as never,
      { allowlist: () => [] } as never,
    );
  const comment = async (commentId: string, extra: object = {}) => {
    await m.Comment.collection.insertOne({
      commentId,
      profileId: PAGE,
      tabId: 'tab_a',
      authorUserId: 'user_writer',
      body: 'Synthetic words.',
      bodySeq: 1,
      source: 'native',
      kind: 'comment',
      createdAt: new Date(),
      ...extra,
    });
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    conn = await mongoose.createConnection(String(uri)).asPromise();
    await conn.dropDatabase();
    for (const { name, schema } of MANAGED_SCHEMAS) {
      m[name] = conn.model(name, schema);
      await m[name].createCollection();
      await m[name].createIndexes();
    }
    m.WebsitePage = conn.model('WebsitePage', WebsitePageSchema);
    m.AdminInboxEntry = conn.model('AdminInboxEntry', AdminInboxEntrySchema);
    await m.SocialProfile.collection.insertOne({
      _id: PAGE,
      slug: 'open-page',
      displayName: 'Synthetic Page',
      visibility: 'public',
      reviewStatus: 'approved',
      ownerUserId: 'user_owner',
    });
    await m.BeliefTab.collection.insertOne({
      profileId: PAGE,
      tabId: 'tab_a',
      title: 'Synthetic',
      order: 0,
    });
    prefs = new NotificationPrefsService(m.NotificationPrefsRow);
    budget = new EmailBudgetStore(m.EmailBudgetDay, config);
    targets = new NotificationTargets(
      m.Comment,
      m.SocialProfile,
      m.BeliefTab,
      m.WebsitePage,
      {
        getIdentity: (userId: string) =>
          Promise.resolve({
            email: `${userId}@example.test`,
            emailVerified: true,
          }),
      } as never,
      { isAllowlisted: () => false } as never,
    );
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    sent.length = 0;
    mail.sendNotice.mockClear();
    for (const name of [
      'NotificationQueueRow',
      'NotificationDigestRow',
      'EmailBudgetDay',
      'NotificationPrefsRow',
    ]) {
      await m[name].deleteMany({});
    }
  });

  it('creates every declared index, the TTLs included', async () => {
    const keys = async (name: string) =>
      (await m[name].collection.indexes()).map((index) => ({
        key: index.key,
        ...(index.unique ? { unique: true } : {}),
        ...(index.expireAfterSeconds !== undefined
          ? { ttl: index.expireAfterSeconds }
          : {}),
        ...(index.partialFilterExpression
          ? { partial: index.partialFilterExpression }
          : {}),
      }));
    expect(await keys('NotificationPrefsRow')).toEqual([
      { key: { _id: 1 } },
      { key: { userId: 1 }, unique: true },
    ]);
    expect(await keys('NotificationQueueRow')).toEqual([
      { key: { _id: 1 } },
      {
        key: { dedupeKey: 1 },
        unique: true,
        partial: { dedupeKey: { $type: 'string' } },
      },
      { key: { status: 1, delivery: 1, nextAttemptAt: 1 } },
      { key: { userId: 1, status: 1, delivery: 1, createdAt: 1 } },
      { key: { expiresAt: 1 }, ttl: 0 },
    ]);
    expect(await keys('NotificationDigestRow')).toEqual([
      { key: { _id: 1 } },
      { key: { userId: 1, day: 1 }, unique: true },
      { key: { expiresAt: 1 }, ttl: 0 },
    ]);
    expect(await keys('EmailBudgetDay')).toEqual([
      { key: { _id: 1 } },
      { key: { expiresAt: 1 }, ttl: 0 },
    ]);
  });

  it('queues one notice per event per reader, and lets moderation notices repeat', async () => {
    const notifier = new MemberNotifier(m.NotificationQueueRow, prefs, {
      kick: () => Promise.resolve(),
    } as never);
    const event = {
      commentId: 'c_dedupe',
      actorUserId: 'user_writer',
      profileId: PAGE,
      tabId: 'tab_a',
      pageOwnerUserId: 'user_owner',
    };
    await Promise.all([
      notifier.commentPosted(event),
      notifier.commentPosted(event),
      notifier.commentPosted(event),
    ]);
    for (const state of ['hidden', null, 'hidden'] as const) {
      await notifier.commentModerated({
        commentId: 'c_dedupe',
        authorUserId: 'user_writer',
        actorUserId: 'user_admin',
        state,
      });
    }
    expect(
      await m.NotificationQueueRow.countDocuments({ kind: 'comment-on-page' }),
    ).toBe(1);
    expect(
      await m.NotificationQueueRow.countDocuments({
        kind: { $in: ['comment-hidden', 'comment-restored'] },
      }),
    ).toBe(3);
  });

  it('sends one digest per member per day with two instances racing, marked in one transaction', async () => {
    await comment('c_digest');
    const notifier = new MemberNotifier(m.NotificationQueueRow, prefs, {
      kick: () => Promise.resolve(),
    } as never);
    await notifier.commentPosted({
      commentId: 'c_digest',
      actorUserId: 'user_writer',
      profileId: PAGE,
      tabId: 'tab_a',
      pageOwnerUserId: 'user_owner',
    });
    // Through the driver: Mongoose never updates `createdAt`.
    await m.NotificationQueueRow.collection.updateMany(
      {},
      { $set: { createdAt: new Date(NOW.getTime() - 60_000) } },
    );
    const [a, b] = [digestSender(), digestSender()];
    await Promise.all([a.run(NOW), b.run(NOW), a.run(NOW), b.run(NOW)]);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('user_owner@example.test');
    // Links, never the comment's words.
    const text = sent[0].lines.join('\n');
    expect(text).toContain('https://org.example.test/open-page');
    expect(text).not.toContain('Synthetic words');
    const digests = await m.NotificationDigestRow.find().lean();
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({ day: '2026-11-13', status: 'sent' });
    const item = await m.NotificationQueueRow.findOne().lean();
    expect(item).toMatchObject({ status: 'sent', digestId: digests[0]._id });
    expect((await budget.status(NOW)).sent).toBe(1);
  });

  it('sends one immediate email per notice under two ticks, and drops what was hidden meanwhile', async () => {
    await comment('c_mod', { moderation: 'hidden' });
    await comment('c_mod_undone');
    const notifier = new MemberNotifier(m.NotificationQueueRow, prefs, {
      kick: () => Promise.resolve(),
    } as never);
    await notifier.commentModerated({
      commentId: 'c_mod',
      authorUserId: 'user_writer',
      actorUserId: 'user_admin',
      state: 'hidden',
    });
    // Hidden, then restored before the email went out.
    await notifier.commentModerated({
      commentId: 'c_mod_undone',
      authorUserId: 'user_writer',
      actorUserId: 'user_admin',
      state: 'hidden',
    });
    const [one, two] = [dispatcher(), dispatcher()];
    await Promise.all([one.kick(), two.kick()]);
    expect(sent).toHaveLength(1);
    expect(sent[0].lines.join('\n')).toContain(
      'A moderator hid one of your comments.',
    );
    expect(
      await m.NotificationQueueRow.find()
        .sort({ createdAt: 1 })
        .lean()
        .then((rows) => rows.map((r: any) => [r.status, r.outcome ?? null])),
    ).toEqual([
      ['sent', null],
      ['skipped', 'no longer visible'],
    ]);
  });

  it('never goes over the day’s budget, however many sends race', async () => {
    const taken = await Promise.all(
      Array.from({ length: 30 }, (_, n) =>
        budget.take(n % 2 ? 'digest' : 'immediate', NOW),
      ),
    );
    expect(taken.filter(Boolean)).toHaveLength(5);
    expect(await m.EmailBudgetDay.findById('2026-11-13').lean()).toMatchObject({
      n: 5,
    });
    expect((await budget.status(NOW)).limitHitAt).toBeDefined();
  });

  it('keeps one settings row per member when two unsubscribe links are used at once', async () => {
    await Promise.all([
      prefs.unsubscribe('user_new', 'replies'),
      prefs.unsubscribe('user_new', 'votes'),
      prefs.unsubscribe('user_new', 'digest'),
    ]);
    expect(
      await m.NotificationPrefsRow.countDocuments({ userId: 'user_new' }),
    ).toBe(1);
    expect(await prefs.get('user_new')).toMatchObject({
      off: expect.arrayContaining(['replies', 'votes']),
      digest: false,
    });
  });
});
