/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
// Reports and moderation (Chunk 13) against a REAL MongoDB replica set: the
// partial unique index behind "one open report per reporter per target", the
// transaction that keeps a decision, its closed reports, its inbox notice and
// its log entry together, the inbox notice that moves up on a new report,
// and that hidden text reaches no reader but an admin. Needs MONGO_TEST_URI
// (a throwaway replica-set database; it is dropped). Without it the suite is
// reported as SKIPPED, never as passed. Synthetic data only.
import { ConflictException } from '@nestjs/common';
import mongoose, { type Model } from 'mongoose';
import { AdminInboxService } from '../src/admin-inbox/admin-inbox.service';
import { reportKey } from '../src/admin-inbox/schemas/admin-inbox.schema';
import { WebsitePageSchema } from '../src/content/schemas/website-page.schema';
import { MANAGED_SCHEMAS } from '../src/db/managed-schemas';
import { AdminMembersService } from '../src/members/admin/admin-members.service';
import { CommentAuthorsService } from '../src/members/comments/comment-authors.service';
import { CommentStore } from '../src/members/comments/comment-store';
import {
  type CommentWriter,
  CommentWritersService,
} from '../src/members/comments/comment-writers';
import {
  ids,
  seedBlocks,
  seedImportedComments,
  seedOrgPages,
  seedProfiles,
  seedTabs,
  U,
} from '../src/members/comments/comments-harness.mocks-spec';
import { CommentsService } from '../src/members/comments/comments.service';
import { MemberPageEditorService } from '../src/members/member-page-editor.service';
import { MembersService } from '../src/members/members.service';
import { ModerationQueueService } from '../src/members/moderation/moderation-queue.service';
import {
  ALREADY_REPORTED,
  REPORTS_PER_DAY,
  ReportsService,
} from '../src/members/moderation/reports.service';
import { OrgPagesService } from '../src/members/org-pages/org-pages.service';
import { VoteTalliesService } from '../src/members/votes/vote-tallies.service';
import { ModerationLogService } from '../src/moderation/moderation-log.service';
import { ReportQuotaStore } from '../src/moderation/report-quota.store';
import { ReportsStore } from '../src/moderation/reports.store';
import { BlockVersionsService } from '../src/social/block-versions.service';
import { CommentVersionsService } from '../src/social/comment-versions.service';

const uri = process.env.MONGO_TEST_URI;
const describeWithMongo = uri ? describe : describe.skip;

const ADMIN = 'user_admin_mod';
const SECRET = 'Synthetic words a moderator will hide.';
const request = (userId?: string) =>
  ({
    headers: userId ? { authorization: `Bearer ${userId}` } : {},
    ...(userId ? { auth: { payload: { sub: userId } } } : {}),
  }) as never;

describeWithMongo('moderation on a real MongoDB', () => {
  jest.setTimeout(30_000);
  let conn: mongoose.Connection;
  const m = {} as Record<string, Model<any>>;
  let members: MembersService;
  let writers: CommentWritersService;
  let comments: CommentsService;
  let reports: ReportsService;
  let inbox: AdminInboxService;
  let queue: ModerationQueueService;
  let admin: AdminMembersService;
  let log: ModerationLogService;
  let build: (log: ModerationLogService) => ModerationQueueService;

  const viewer = (userId?: string) => members.resolveViewer(request(userId));
  const writer = (userId: string): Promise<CommentWriter> =>
    writers.requireWriter(request(userId));
  // Most tests write on tab_a; the one that reads a whole thread uses tab_b,
  // so the other tests' comments never push its comment off the first page.
  const post = async (
    userId = U.named,
    body = 'Synthetic words.',
    tabId = 'tab_a',
  ) =>
    (
      await comments.create(await writer(userId), {
        slug: 'open-page',
        tabId,
        body,
      })
    ).commentId;
  const reportOn = async (commentId: string, userId = U.anon) =>
    reports.report(await writer(userId), {
      targetType: 'comment',
      commentId,
      reason: 'harassment',
    });
  const actionsFor = async (targetId: string) =>
    (await m.ModerationLogEntry.find({ targetId }).sort({ at: 1 }).lean()).map(
      (row: any) => row.action,
    );

  beforeAll(async () => {
    conn = await mongoose.createConnection(String(uri)).asPromise();
    await conn.dropDatabase();
    for (const { name, schema } of MANAGED_SCHEMAS) {
      m[name] = conn.model(name, schema);
      await m[name].createCollection();
      await m[name].createIndexes();
    }
    m.WebsitePage = conn.model('WebsitePage', WebsitePageSchema);
    await m.WebsitePage.collection.insertMany(seedOrgPages());
    const seeded = seedBlocks();
    await m.SocialProfile.collection.insertMany(seedProfiles());
    await m.BeliefTab.collection.insertMany(
      seedTabs().map((t) => ({ ...t, createdAt: new Date() })),
    );
    await m.ProfileBlock.collection.insertMany(seeded.map((s) => s.block));
    await m.BlockVersion.collection.insertMany(seeded.map((s) => s.version));
    await m.Comment.collection.insertMany(seedImportedComments());

    members = new MembersService(
      m.SocialProfile,
      m.BeliefTab,
      m.ProfileBlock,
      m.BlockVersion,
      m.Comment,
      { currentPicture: () => Promise.resolve(undefined) } as never,
      {} as never,
      {
        isAdminForRead: (req: { auth: { payload: { sub: string } } }) =>
          Promise.resolve(req.auth.payload.sub.startsWith('user_admin')),
      } as never,
    );
    writers = new CommentWritersService(members, {
      getIdentity: (userId: string) =>
        Promise.resolve({
          email: `${userId}@example.test`,
          emailVerified: true,
        }),
    } as never);
    const orgPages = new OrgPagesService(m.WebsitePage);
    const tallies = new VoteTalliesService(
      m.VoteTally,
      m.BeliefVote,
      m.BeliefTab,
      m.ProfileBlock,
      m.BlockVersion,
      orgPages,
    );
    const editor = new MemberPageEditorService(
      m.SocialProfile,
      m.BeliefTab,
      m.ProfileBlock,
      m.BlockVersion,
      new BlockVersionsService(m.BlockVersion, m.ProfileBlock),
      tallies,
    );
    const store = new CommentStore(m.Comment);
    const versions = new CommentVersionsService(m.CommentVersion);
    const authors = new CommentAuthorsService(m.SocialProfile);
    comments = new CommentsService(
      m.BeliefTab,
      store,
      members,
      editor,
      versions,
      authors,
      m.BeliefVote,
      orgPages,
    );
    log = new ModerationLogService(m.ModerationLogEntry);
    inbox = new AdminInboxService(
      m.AdminInboxEntry,
      m.SocialProfile,
      conn,
      log,
    );
    reports = new ReportsService(
      m.Report,
      store,
      comments,
      members,
      orgPages,
      inbox,
      new ReportQuotaStore(m.ReportQuota),
      m.Comment,
      conn,
    );
    build = (withLog) =>
      new ModerationQueueService(
        m.Report,
        m.Comment,
        m.SocialProfile,
        m.BeliefTab,
        conn,
        versions,
        authors,
        new ReportsStore(m.Report),
        inbox,
        withLog,
      );
    queue = build(log);
    admin = new AdminMembersService(
      m.SocialProfile,
      conn,
      log,
      inbox,
      new ReportsStore(m.Report),
    );
  });

  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it('runs on a replica set (transactions are what this suite tests)', async () => {
    const hello = await conn.db!.admin().command({ hello: 1 });
    expect(hello.setName).toBeTruthy();
  });

  it('declares the report indexes db:indexes creates', async () => {
    const indexes = await m.Report.collection.indexes();
    const byKey = new Map(indexes.map((i) => [JSON.stringify(i.key), i]));
    expect(
      byKey.get('{"targetType":1,"targetId":1,"reporterUserId":1}'),
    ).toMatchObject({
      unique: true,
      partialFilterExpression: { status: 'open' },
    });
    expect(
      byKey.get('{"status":1,"targetType":1,"targetId":1,"createdAt":1}'),
    ).toBeDefined();
    expect(byKey.get('{"reporterUserId":1,"createdAt":-1}')).toBeDefined();
    expect(indexes).toHaveLength(4);
  });

  it('declares the report-quota indexes: one counter per reporter per day, with a TTL', async () => {
    const indexes = await m.ReportQuota.collection.indexes();
    const byKey = new Map(indexes.map((i) => [JSON.stringify(i.key), i]));
    expect(byKey.get('{"reporterUserId":1,"day":1}')).toMatchObject({
      unique: true,
    });
    expect(byKey.get('{"expiresAt":1}')).toMatchObject({
      expireAfterSeconds: 0,
    });
  });

  it('holds the daily cap under 25 reports at once: exactly 10 stored (review M-1)', async () => {
    const targets: string[] = [];
    for (let i = 0; i < 25; i++) targets.push(await post());
    const reporter = await writer(U.membersOwner);
    const outcomes = await Promise.allSettled(
      targets.map((commentId) =>
        reports.report(reporter, {
          targetType: 'comment',
          commentId,
          reason: 'spam',
        }),
      ),
    );
    expect(
      await m.Report.countDocuments({ reporterUserId: U.membersOwner }),
    ).toBe(REPORTS_PER_DAY);
    const refused = outcomes.filter((o) => o.status === 'rejected');
    expect(refused).toHaveLength(25 - REPORTS_PER_DAY);
    for (const outcome of refused) {
      expect(outcome.reason.getStatus()).toBe(429);
    }
    expect(
      (await m.ReportQuota.findOne({ reporterUserId: U.membersOwner }).lean())
        .n,
    ).toBe(REPORTS_PER_DAY);
  });

  it('never leaves a report open on a comment a moderator hid at the same moment (review L-4)', async () => {
    for (let round = 0; round < 8; round++) {
      const commentId = await post();
      const [reported, hidden] = await Promise.allSettled([
        reportOn(commentId, U.hiddenOwner),
        queue.moderateComment(ADMIN, commentId, 'hide', 'Synthetic race'),
      ]);
      expect(hidden.status).toBe('fulfilled');
      expect(
        await m.Report.countDocuments({ targetId: commentId, status: 'open' }),
      ).toBe(0);
      const stored = await m.Report.countDocuments({ targetId: commentId });
      // Either the report came first and the hide closed it, or the hide
      // came first and the report was refused.
      expect(stored).toBe(reported.status === 'fulfilled' ? 1 : 0);
      if (reported.status === 'rejected') {
        expect(reported.reason).toBeInstanceOf(ConflictException);
      }
    }
  });

  it('allows one open report per reporter per target, and a new one once closed', async () => {
    const commentId = await post();
    await reportOn(commentId);
    await expect(reportOn(commentId)).rejects.toThrow(
      new ConflictException(ALREADY_REPORTED),
    );
    await reportOn(commentId, U.owner);
    await queue.dismiss(ADMIN, 'comment', commentId, 'Synthetic: fine');
    await expect(reportOn(commentId)).resolves.toEqual({ reported: true });
    expect(
      await m.Report.countDocuments({ targetId: commentId, status: 'open' }),
    ).toBe(1);
  });

  it('keeps one inbox notice per target, moved up and re-opened by a new report', async () => {
    const commentId = await post();
    await reportOn(commentId);
    const first = await m.AdminInboxEntry.findOne({
      dedupeKey: reportKey('comment', commentId),
    }).lean();
    expect(first).toMatchObject({
      kind: 'report',
      status: 'open',
      subjectUserId: U.named,
      targetType: 'comment',
      targetId: commentId,
    });
    await m.AdminInboxEntry.updateOne(
      { _id: first._id },
      { $set: { status: 'handled', handledBy: ADMIN, handledAt: new Date() } },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await reportOn(commentId, U.owner);
    const bumped = await m.AdminInboxEntry.find({
      dedupeKey: reportKey('comment', commentId),
    }).lean();
    expect(bumped).toHaveLength(1);
    expect(bumped[0].status).toBe('open');
    expect(bumped[0].handledBy).toBeUndefined();
    expect(bumped[0].createdAt.getTime()).toBeGreaterThan(
      first.createdAt.getTime(),
    );
    const { entries } = await inbox.list('open', 1);
    expect(entries[0]).toMatchObject({
      kind: 'report',
      target: { type: 'comment', id: commentId },
    });
  });

  it('hides a comment, closing its reports and notice and logging it, all at once', async () => {
    const commentId = await post(U.named, SECRET, 'tab_b');
    await reportOn(commentId);
    await reportOn(commentId, U.owner);
    await expect(
      queue.moderateComment(ADMIN, commentId, 'hide', 'Synthetic: abuse'),
    ).resolves.toEqual({ moderation: 'hidden', reportsClosed: 2 });
    expect(
      await m.Report.find({ targetId: commentId }).distinct('resolution'),
    ).toEqual(['hidden']);
    expect(
      (
        await m.AdminInboxEntry.findOne({
          dedupeKey: reportKey('comment', commentId),
        }).lean()
      ).status,
    ).toBe('handled');
    expect(await actionsFor(commentId)).toEqual(['comment.hidden']);

    // Readers see the place, never the text; an admin reads it.
    for (const userId of [undefined, U.anon, U.owner, U.named]) {
      const reader = await viewer(userId);
      const thread = await comments.thread(
        'open-page',
        reader,
        'tab_b',
        undefined,
        await writers.writeStatus(reader),
      );
      expect(JSON.stringify(thread)).not.toContain(SECRET);
      expect(
        thread.comments.find((c) => c.commentId === commentId),
      ).toMatchObject({ moderated: 'hidden' });
    }
    const adminThread = await comments.thread(
      'open-page',
      await viewer(ADMIN),
      'tab_b',
      undefined,
      { mayComment: true },
    );
    expect(JSON.stringify(adminThread)).toContain(SECRET);
    // The text and its version are still stored, untouched.
    expect(
      await m.CommentVersion.countDocuments({ commentId, text: SECRET }),
    ).toBe(1);

    await queue.moderateComment(ADMIN, commentId, 'restore', 'Synthetic: ok');
    const back = await m.Comment.findOne({ commentId }).lean();
    expect(back.moderation).toBeUndefined();
    expect(await actionsFor(commentId)).toEqual([
      'comment.hidden',
      'comment.restored',
    ]);
  });

  it('writes nothing at all when the log entry fails', async () => {
    const commentId = await post();
    await reportOn(commentId);
    const failing = build({
      record: () => Promise.reject(new Error('synthetic log failure')),
    } as never);
    await expect(
      failing.moderateComment(ADMIN, commentId, 'remove', 'Synthetic'),
    ).rejects.toThrow('synthetic log failure');
    expect((await m.Comment.findOne({ commentId }).lean()).moderation).toBe(
      undefined,
    );
    expect(
      await m.Report.countDocuments({ targetId: commentId, status: 'open' }),
    ).toBe(1);
    expect(
      (
        await m.AdminInboxEntry.findOne({
          dedupeKey: reportKey('comment', commentId),
        }).lean()
      ).status,
    ).toBe('open');
    expect(await actionsFor(commentId)).toEqual([]);
  });

  it('lists the queue grouped by target, with the reporter for admins only', async () => {
    const commentId = await post(U.named, SECRET);
    await reportOn(commentId);
    await reportOn(commentId, U.owner);
    const { entries } = await queue.queue(ADMIN, 'open', 1);
    const entry = entries.find((e) => e.targetId === commentId)!;
    expect(entry).toMatchObject({
      count: 2,
      comment: {
        body: SECRET,
        place: { kind: 'member-page', slug: 'open-page' },
      },
    });
    expect(entry.reports.map((r) => r.reporterUserId)).toEqual([
      U.anon,
      U.owner,
    ]);
  });

  it('closes a member page’s reports when the Members section removes it', async () => {
    await reports.report(await writer(U.anon), {
      targetType: 'member-page',
      slug: 'named-writer',
      reason: 'personal-information',
    });
    await admin.remove(ADMIN, 'named-writer', 'Synthetic: reported page');
    const closed = await m.Report.findOne({
      targetId: String(ids.named),
    }).lean();
    expect(closed).toMatchObject({
      status: 'resolved',
      resolution: 'member-removed',
      resolvedBy: ADMIN,
    });
    expect(
      (
        await m.AdminInboxEntry.findOne({
          dedupeKey: reportKey('member-page', String(ids.named)),
        }).lean()
      ).status,
    ).toBe('handled');
    await admin.restore(ADMIN, 'named-writer', 'Synthetic: restore');
  });

  it('reports a comment on an ORG page, whose page is not a member page', async () => {
    const made = await comments.createOnOrgPage(await writer(U.named), {
      pageId: 'about',
      body: SECRET,
    });
    await reportOn(made.commentId);
    const row = await m.Report.findOne({ targetId: made.commentId }).lean();
    expect(row.targetProfileId.equals(ids.orgAbout)).toBe(true);
    const { entries } = await queue.queue(ADMIN, 'open', 1);
    expect(
      entries.find((e) => e.targetId === made.commentId)!.comment!.place,
    ).toEqual({ kind: 'org-page', pageId: 'about' });
    await queue.moderateComment(ADMIN, made.commentId, 'hide', 'Synthetic');
    const guest = await comments.orgThread('about', await viewer(), undefined, {
      mayComment: false,
      block: 'sign-in',
    });
    expect(JSON.stringify(guest)).not.toContain(SECRET);
  });

  it('never lets an id that is not a comment change anything', async () => {
    await expect(
      queue.moderateComment(ADMIN, 'cmt_does_not_exist', 'hide', 'r'),
    ).rejects.toThrow('That comment does not exist.');
    expect(
      await m.ModerationLogEntry.countDocuments({
        targetId: 'cmt_does_not_exist',
      }),
    ).toBe(0);
  });
});
