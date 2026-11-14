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
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import mongoose, { type Model, Types } from 'mongoose';
import request from 'supertest';
import { AdminAccessService } from '../src/auth/admin-access.service';
import { ClerkAuthGuard } from '../src/auth/auth.guard';
import { configureHttpApp } from '../src/config/http-app';
import { DEFAULT_THROTTLE } from '../src/config/throttle';
import { MyNotificationSettingsController } from '../src/member-notifications/notifications.controller';
import { required } from './members-test-app';
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

  it('sends the oldest immediate email first, even after it waited for a new day (review M1)', async () => {
    await comment('c_old', { moderation: 'hidden' });
    await comment('c_new', { moderation: 'hidden' });
    const now = new Date();
    const row = (commentId: string, createdAt: Date, extra: object = {}) => ({
      userId: 'user_writer',
      category: 'moderation',
      kind: 'comment-hidden',
      delivery: 'immediate',
      status: 'queued',
      refs: { commentId },
      attempts: 0,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(now.getTime() + 20 * 86_400_000),
      ...extra,
    });
    // Yesterday's, held back for want of budget until today; then today's.
    await m.NotificationQueueRow.collection.insertMany([
      row('c_old', new Date(now.getTime() - 86_400_000), {
        nextAttemptAt: new Date(now.getTime() - 1000),
      }),
      row('c_new', new Date(now.getTime() - 60_000)),
    ]);
    // Room for exactly one immediate email today.
    const today = now.toISOString().slice(0, 10);
    await m.EmailBudgetDay.collection.insertOne({
      _id: today as never,
      n: 4,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    await dispatcher().kick();
    expect(sent).toHaveLength(1);
    const sentRow = await m.NotificationQueueRow.findOne({
      status: 'sent',
    }).lean();
    expect(sentRow.refs.commentId).toBe('c_old');
  });

  it('saves settings in one write on a real server: flags it names, off-list as a set (review N8)', async () => {
    await prefs.unsubscribe('user_set', 'votes');
    await prefs.update('user_set', true, {
      categories: { replies: false, votes: true, adminEam: false },
      digest: false,
    });
    expect(await prefs.get('user_set')).toMatchObject({
      off: expect.arrayContaining(['replies', 'adminEam']),
      digest: false,
      immediate: true,
      adminImmediate: true,
    });
    expect((await prefs.get('user_set')).off).not.toContain('votes');
    // A first save makes the row in the same single write.
    await prefs.update('user_first', false, {
      categories: { comments: false },
    });
    expect(await prefs.get('user_first')).toMatchObject({
      off: ['comments'],
      digest: true,
    });
    expect(
      await m.NotificationPrefsRow.countDocuments({ userId: 'user_first' }),
    ).toBe(1);
  });

  it('never starts a second digest while another instance holds the member’s row, across midnight (review N2)', async () => {
    await comment('c_n2');
    const notifier = new MemberNotifier(m.NotificationQueueRow, prefs, {
      kick: () => Promise.resolve(),
    } as never);
    await notifier.commentPosted({
      commentId: 'c_n2',
      actorUserId: 'user_writer',
      profileId: PAGE,
      tabId: 'tab_a',
      pageOwnerUserId: 'user_owner',
    });
    const item = await m.NotificationQueueRow.findOne().lean();
    await m.NotificationQueueRow.collection.updateMany(
      {},
      { $set: { createdAt: new Date(NOW.getTime() - 60_000) } },
    );
    const tomorrow = new Date('2026-11-14T15:00:00Z');
    await m.NotificationDigestRow.collection.insertOne({
      userId: 'user_owner',
      day: '2026-11-13',
      status: 'sending',
      itemIds: [item._id],
      attempts: 0,
      keyGen: 0,
      leaseUntil: new Date(tomorrow.getTime() + 5 * 60_000),
      leaseToken: 'alive',
      expiresAt: new Date(tomorrow.getTime() + 86_400_000),
    });
    expect(await digestSender().forMember('user_owner', tomorrow)).toBe(
      'skipped',
    );
    expect(await m.NotificationDigestRow.countDocuments()).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it('a one-field save through the real route and validation pipe changes that field only (review round 3, HIGH 1)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([DEFAULT_THROTTLE])],
      controllers: [MyNotificationSettingsController],
      providers: [
        { provide: NotificationPrefsService, useValue: prefs },
        {
          provide: AdminAccessService,
          useValue: { isAdminForRead: () => Promise.resolve(false) },
        },
      ],
    })
      .overrideGuard(ClerkAuthGuard)
      .useValue(required)
      .compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpApp(app, { origins: ['http://localhost'], trustProxyHops: 1 });
    await app.init();
    try {
      await prefs.unsubscribe('user_route', 'claims');
      await request(app.getHttpServer())
        .put('/api/v1/me/notification-settings')
        .set('Origin', 'http://localhost')
        .set('Authorization', 'Bearer user_route')
        .send({ categories: { votes: false } })
        .expect(200);
      const row = await m.NotificationPrefsRow.findOne({
        userId: 'user_route',
      }).lean();
      expect([...row.off].sort()).toEqual(['claims', 'votes']);
      expect(await prefs.get('user_route')).toMatchObject({
        digest: true,
        immediate: true,
        adminImmediate: true,
      });
    } finally {
      await app.close();
    }
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
