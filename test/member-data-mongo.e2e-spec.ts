/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
// "Delete my page", the export and the five-year purge (Chunk 17) against a
// REAL MongoDB replica set: the deletion's transaction and log, every surface
// that must stop showing the page, the export after deletion, and the purge
// writing through the ONE append-only exception on the real driver
// (immutable fields included) while every other write stays refused. Needs
// MONGO_TEST_URI (a throwaway replica-set database; it is dropped) and, for
// the standalone case, MONGO_STANDALONE_URI. Without them the suites are
// SKIPPED, never passed. Synthetic data only.
import { ConnectionRecords } from '../src/connections/connection-records.service';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { strFromU8, unzipSync } from 'fflate';
import mongoose, { type Model } from 'mongoose';
import { WebsitePageSchema } from '../src/content/schemas/website-page.schema';
import { MANAGED_SCHEMAS } from '../src/db/managed-schemas';
import { purgeAfterOf } from '../src/member-data/member-data.constants';
import { MemberExportService } from '../src/member-data/member-export.service';
import {
  MemberPurgeService,
  PURGED_NAME,
  purgedSlug,
} from '../src/member-data/member-purge.service';
import { PageDeletionService } from '../src/member-data/page-deletion.service';
import {
  accountDeletedKey,
  accountDeletedRows,
  parseAccountDeleted,
} from '../src/anchoring/account-deletion-record';
import { buildTree, leafHash } from '../src/anchoring/merkle';
import { makeTestTsa } from '../src/anchoring/test-tsa.mocks-spec';
import { PurgeMarksService } from '../src/anchoring/purge-marks.service';
import { redactionRow } from '../src/anchoring/redaction';
import { leafId } from '../src/anchoring/schemas/anchor-leaf.schema';
import { toRecord } from '../src/anchoring/version-records';
import { CommentAuthorsService } from '../src/members/comments/comment-authors.service';
import { CommentStore } from '../src/members/comments/comment-store';
import { ForbiddenException } from '@nestjs/common';
import { CommentWritersService } from '../src/members/comments/comment-writers';
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
import { OrgPagesService } from '../src/members/org-pages/org-pages.service';
import { ReceiptsService } from '../src/members/receipts/receipts.service';
import { VoteTalliesService } from '../src/members/votes/vote-tallies.service';
import { ModerationLogService } from '../src/moderation/moderation-log.service';
import { PERSON_DETAIL_KEYS } from '../src/moderation/log-details';
import { AppendOnlyViolationError } from '../src/social/append-only';
import { BlockVersionsService } from '../src/social/block-versions.service';
import { CommentVersionsService } from '../src/social/comment-versions.service';
import { PURGE_OPTION, PURGED_PERSON } from '../src/social/purge-rules';

const uri = process.env.MONGO_TEST_URI;
const standaloneUri = process.env.MONGO_STANDALONE_URI;
const describeWithMongo = uri ? describe : describe.skip;
const describeStandalone = standaloneUri ? describe : describe.skip;

const request = (userId?: string) =>
  ({
    headers: userId ? { authorization: `Bearer ${userId}` } : {},
    ...(userId ? { auth: { payload: { sub: userId } } } : {}),
  }) as never;

// Plain objects, as the service passes them (an inline literal trips TS's
// excess-property check on Mongoose's option type).
const PURGE: Record<string, unknown> = {
  [PURGE_OPTION]: true,
  overwriteImmutable: true,
};
const PURGE_ONLY: Record<string, unknown> = { [PURGE_OPTION]: true };
const DELETED_AT = new Date('2026-11-14T12:00:00Z');
const PURGE_AT = new Date(purgeAfterOf(DELETED_AT).getTime() + 60_000);

describeWithMongo('page deletion, export and purge on a real MongoDB', () => {
  jest.setTimeout(60_000);
  let conn: mongoose.Connection;
  const m = {} as Record<string, Model<any>>;
  let members: MembersService;
  let comments: CommentsService;
  let writers: CommentWritersService;
  let deletion: PageDeletionService;
  let purge: MemberPurgeService;
  let exporter: MemberExportService;
  let records: ConnectionRecords;
  let myCommentId: string;
  let theirCommentId: string;

  const viewer = (userId?: string) => members.resolveViewer(request(userId));

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
      {
        currentPicture: () => Promise.resolve(undefined),
        livePictures: () => Promise.resolve(new Set()),
      } as never,
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
    const authors = new CommentAuthorsService(m.SocialProfile);
    comments = new CommentsService(
      m.BeliefTab,
      new CommentStore(m.Comment),
      members,
      editor,
      new CommentVersionsService(m.CommentVersion),
      authors,
      m.BeliefVote,
      orgPages,
    );
    const log = new ModerationLogService(m.ModerationLogEntry);
    records = new ConnectionRecords(
      m.MemberConnection,
      m.ConnectionBlock,
      m.ConnectionSettings,
      m.SocialProfile,
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
    purge = new MemberPurgeService(
      m.SocialProfile,
      m.BeliefTab,
      m.ProfileBlock,
      m.BlockVersion,
      m.Comment,
      m.CommentVersion,
      m.BeliefVote,
      m.VoteHistoryEntry,
      m.Claim,
      m.Report,
      m.ModerationLogEntry,
      m.ConsentRecord,
      m.VisitRecord,
      m.MemberContacts,
      m.NotificationPrefsRow,
      m.NotificationQueueRow,
      m.AdminInboxEntry,
      m.ImportRecord,
      m.SearchEntry,
      m.PurgeRunLock,
      m.AccountDeletion,
      { remove: () => Promise.resolve() } as never,
      log,
      m.UserWriteGate,
      records,
    );
    // No anchoring here: receipts are covered by the unit suite. A real
    // ReceiptsService, so the export goes through its disclosure code.
    const receipts = new ReceiptsService(
      {} as never,
      {} as never,
      {
        chainPeople: () => Promise.resolve([]),
        proveVersion: () => Promise.resolve({ anchored: false }),
      } as never,
      authors,
    );
    exporter = new MemberExportService(
      m.SocialProfile,
      m.BeliefTab,
      m.ProfileBlock,
      m.BlockVersion,
      m.Comment,
      m.CommentVersion,
      m.BeliefVote,
      m.Claim,
      m.Report,
      m.NotificationPrefsRow,
      m.ConsentRecord,
      m.MemberContacts,
      m.AnchorLeaf,
      receipts,
      authors,
      { currentPicture: () => Promise.resolve(undefined) } as never,
      records,
    );

    // The member whose page will go writes on someone else's page, and
    // someone else writes on theirs.
    myCommentId = (
      await comments.create(await writers.requireWriter(request(U.named)), {
        slug: 'open-page',
        tabId: 'tab_a',
        body: 'Synthetic words by the leaving member.',
      })
    ).commentId;
    theirCommentId = (
      await comments.create(await writers.requireWriter(request(U.owner)), {
        slug: 'named-writer',
        tabId: 'tab_n',
        body: 'Synthetic words by another member.',
      })
    ).commentId;
    await m.ConsentRecord.create({
      userId: U.named,
      termsVersion: '1',
      termsHash: 'a'.repeat(64),
      acceptedAt: DELETED_AT,
      ip: '203.0.113.20',
    });
    await m.VisitRecord.create({
      kind: 'guest-entry',
      at: new Date('2020-01-01T00:00:00Z'),
      ip: '198.51.100.20',
    });
    await m.SearchEntry.collection.insertOne({
      _id: `member:${String(ids.named)}`,
      kind: 'member',
      profileId: ids.named,
      text: 'Synthetic',
    } as never);
  });

  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it('deletes in one transaction with its log entry; every surface stops showing the page', async () => {
    await deletion.deleteOwn(U.named, 'named-writer', DELETED_AT);
    const log = await m.ModerationLogEntry.find({
      action: 'page.deleted',
    }).lean();
    expect(log).toHaveLength(1);
    for (const who of [undefined, U.owner, U.named, U.admin]) {
      await expect(
        members.findVisible('named-writer', await viewer(who)),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    const directory = await members.directory(await viewer(U.owner));
    expect(JSON.stringify(directory)).not.toContain('named-writer');
    const scope = await members.searchScope(await viewer(U.admin));
    expect(scope.listed.map(String)).not.toContain(String(ids.named));
    // Their comment elsewhere keeps its place and text, by "a former member".
    const thread = await (async () => {
      const v = await viewer(U.owner);
      return comments.thread(
        'open-page',
        v,
        'tab_a',
        undefined,
        await writers.writeStatus(v),
      );
    })();
    const mine = thread.comments.find((c: any) => c.commentId === myCommentId)!;
    expect(mine.author).toEqual({ kind: 'member', former: true });
    expect(mine.body).toBe('Synthetic words by the leaving member.');
  });

  it('exports after deletion: the member’s own data, nobody else’s id', async () => {
    const { data, zip } = await exporter.build(
      U.named,
      await viewer(U.named),
      DELETED_AT,
    );
    expect(data.page).toMatchObject({
      address: 'named-writer',
      status: 'deleted',
    });
    expect(data.myComments.map((c) => c.commentId)).toEqual([myCommentId]);
    expect(data.commentsOnMyPage.map((c: any) => c.commentId)).toEqual([
      theirCommentId,
    ]);
    const all = Object.entries(unzipSync(zip))
      .map(([, bytes]) => strFromU8(bytes))
      .join('\n');
    expect(all).toContain('Synthetic words by the leaving member.');
    expect(all).not.toContain(U.owner);
    expect(all).toContain('203.0.113.20');
  });

  it('undoes inside the window, then deletes again', async () => {
    await deletion.undoOwn(U.named, new Date(DELETED_AT.getTime() + 60_000));
    await expect(
      members.findVisible('named-writer', await viewer(U.owner)),
    ).resolves.toBeDefined();
    await deletion.deleteOwn(U.named, 'named-writer', DELETED_AT);
    await expect(deletion.accountDeleted(U.named, DELETED_AT)).resolves.toBe(
      'deleted',
    );
    await expect(deletion.accountDeleted(U.named, DELETED_AT)).resolves.toBe(
      'already',
    );
    // Round 4, #2: the anchored deletion record, once, ids only, written
    // in the webhook's transaction on the real driver.
    const account = await m.AccountDeletion.findOne({
      userId: U.named,
    }).lean();
    const records = await m.CommentVersion.find({
      commentId: accountDeletedKey(String(account._id)),
    }).lean();
    expect(records).toHaveLength(1);
    expect(parseAccountDeleted(records[0].text)).toMatchObject({
      accountId: String(account._id),
      deletedAt: DELETED_AT.toISOString(),
      commentIds: [myCommentId],
    });
    expect(JSON.stringify(records)).not.toContain(U.named);
  });

  it('keeps the append-only guard shut to everything but the exact purge, on the real driver', async () => {
    const filter = { blockId: 'blk_n1' };
    const now = new Date();
    await expect(
      m.BlockVersion.updateMany(filter, { $set: { text: 'rewritten' } }).exec(),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
    await expect(
      m.BlockVersion.updateMany(
        filter,
        {
          $set: {
            text: '',
            authorUserId: PURGED_PERSON,
            hash: 'f'.repeat(64),
            purgedAt: now,
          },
        },
        PURGE,
      ).exec(),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
    await expect(
      m.BlockVersion.updateMany(
        filter,
        {
          $set: {
            text: 'rewritten',
            authorUserId: PURGED_PERSON,
            purgedAt: now,
          },
        },
        PURGE,
      ).exec(),
    ).rejects.toBeInstanceOf(AppendOnlyViolationError);
    // Measured on throwaway rows: without overwriteImmutable, Mongoose
    // silently strips the immutable text and author, which is why the purge
    // passes it. With it, they are written.
    for (const blockId of ['blk_tmp1', 'blk_tmp2']) {
      await m.BlockVersion.collection.insertOne({
        blockId,
        seq: 1,
        text: 'Throwaway synthetic text.',
        authorUserId: 'user_tmp',
        createdAt: now,
        prevHash: '0'.repeat(64),
        hash: '1'.repeat(64),
      });
    }
    const purgeSet = {
      $set: { text: '', authorUserId: PURGED_PERSON, purgedAt: now },
    };
    const notYet = (blockId: string) => ({
      blockId,
      purgedAt: { $exists: false },
    });
    // Review #7 on the real driver: no guard, an empty filter, an upsert.
    for (const [filter, options] of [
      [{ blockId: 'blk_tmp1' }, PURGE],
      [{}, PURGE],
      [notYet('blk_tmp1'), { ...PURGE, upsert: true }],
    ] as const) {
      await expect(
        m.BlockVersion.updateMany(filter, purgeSet, options).exec(),
      ).rejects.toBeInstanceOf(AppendOnlyViolationError);
    }
    await m.BlockVersion.updateMany(
      notYet('blk_tmp1'),
      purgeSet,
      PURGE_ONLY,
    ).exec();
    expect(
      await m.BlockVersion.findOne({ blockId: 'blk_tmp1' }).lean(),
    ).toMatchObject({
      text: 'Throwaway synthetic text.',
      authorUserId: 'user_tmp',
      purgedAt: now,
    });
    await m.BlockVersion.updateMany(notYet('blk_tmp2'), purgeSet, PURGE).exec();
    expect(
      await m.BlockVersion.findOne({ blockId: 'blk_tmp2' }).lean(),
    ).toMatchObject({
      text: '',
      authorUserId: PURGED_PERSON,
      hash: '1'.repeat(64),
    });
    const row = await m.BlockVersion.findOne(filter).lean();
    expect(row.text).toBe('Named belief.');
    expect(row).not.toHaveProperty('purgedAt');
  });

  it('purges nothing inside the five years', async () => {
    const early = new Date(purgeAfterOf(DELETED_AT).getTime() - 60_000);
    expect((await purge.due(early)).pages).toEqual([]);
    expect(await purge.run(early)).toMatchObject({
      state: 'ran',
      purged: [],
      visitAddressesRemoved: 1,
    });
    const row = await m.BlockVersion.findOne({ blockId: 'blk_n1' }).lean();
    expect(row.text).toBe('Named belief.');
  });

  it('after five years removes the personal content and keeps every hash', async () => {
    const before = await m.BlockVersion.find({ blockId: 'blk_n1' })
      .sort({ seq: 1 })
      .lean();
    const beforeComment = await m.CommentVersion.find({
      commentId: myCommentId,
    }).lean();
    expect((await purge.due(PURGE_AT)).pages.map((p) => p.slug)).toEqual([
      'named-writer',
    ]);
    const report = await purge.run(PURGE_AT, true);
    expect(report).toMatchObject({
      state: 'ran',
      purged: [String(ids.named)],
      accounts: [expect.any(String)],
      failed: [],
      // The 2020 visit went in the earlier run: by 2031 it was five years old.
      visitAddressesRemoved: 0,
    });

    const after = await m.BlockVersion.find({ blockId: 'blk_n1' })
      .sort({ seq: 1 })
      .lean();
    expect(after.map((r) => [r.seq, r.hash, r.prevHash])).toEqual(
      before.map((r) => [r.seq, r.hash, r.prevHash]),
    );
    for (const r of after) {
      expect(r).toMatchObject({ text: '', authorUserId: PURGED_PERSON });
      expect(r.purgedAt).toEqual(PURGE_AT);
    }
    const commentAfter = await m.CommentVersion.find({
      commentId: myCommentId,
    }).lean();
    expect(commentAfter.map((r) => r.hash)).toEqual(
      beforeComment.map((r) => r.hash),
    );
    expect(commentAfter[0]).toMatchObject({
      text: '',
      authorUserId: PURGED_PERSON,
    });

    const pageRow = await m.SocialProfile.findById(ids.named).lean();
    expect(pageRow).toMatchObject({
      slug: purgedSlug(ids.named),
      displayName: PURGED_NAME,
      deletion: { purgedAt: PURGE_AT },
    });
    expect(pageRow).not.toHaveProperty('ownerUserId');
    expect(await m.SearchEntry.countDocuments({ profileId: ids.named })).toBe(
      0,
    );
    const consent = await m.ConsentRecord.findOne({
      termsHash: 'a'.repeat(64),
    }).lean();
    expect(consent.userId).toBe(PURGED_PERSON);
    expect(consent).not.toHaveProperty('ip');
    expect(await m.VisitRecord.countDocuments({ ip: { $exists: true } })).toBe(
      0,
    );

    // The thread keeps the comment's place; it names no one and has no text.
    const thread = await (async () => {
      const v = await viewer(U.owner);
      return comments.thread(
        'open-page',
        v,
        'tab_a',
        undefined,
        await writers.writeStatus(v),
      );
    })();
    const mine = thread.comments.find((c: any) => c.commentId === myCommentId)!;
    expect(mine.author).toEqual({ kind: 'member', former: true });
    // Another member's comment on the purged page keeps its text.
    const theirs = await m.Comment.findOne({
      commentId: theirCommentId,
    }).lean();
    expect(theirs.body).toBe('Synthetic words by another member.');
    // Nothing in the database still names the member.
    for (const name of [
      'SocialProfile',
      'BlockVersion',
      'CommentVersion',
      'Comment',
      'ConsentRecord',
      'ModerationLogEntry',
    ]) {
      expect(
        await m[name].countDocuments({
          $or: [
            { ownerUserId: U.named },
            { authorUserId: U.named },
            { userId: U.named },
            { actorUserId: U.named },
            { 'details.ownerUserId': U.named },
          ],
        }),
      ).toBe(0);
    }
    expect(
      await m.ModerationLogEntry.countDocuments({ action: 'page.purged' }),
    ).toBe(1);
    // Restoring is no longer possible.
    await expect(
      deletion.adminRestore(
        U.admin,
        purgedSlug(ids.named),
        'Too late.',
        PURGE_AT,
      ),
    ).rejects.toThrow('cannot be brought back');
  });

  it('runs once per day and holds one lock across callers', async () => {
    await expect(purge.run(PURGE_AT)).resolves.toMatchObject({
      state: 'already-ran',
    });
    await m.PurgeRunLock.updateOne(
      { _id: 'member-purge' },
      { $set: { holder: 'other', until: new Date(Date.now() + 60_000) } },
    );
    await expect(purge.run(PURGE_AT, true)).resolves.toEqual({ state: 'busy' });
  });

  it('declares the indexes the chunk relies on', async () => {
    const pageIndexes = await m.SocialProfile.collection.indexes();
    expect(pageIndexes.some((i) => i.key['deletion.purgeAfter'] === 1)).toBe(
      true,
    );
    const gates = await m.UserWriteGate.collection.indexes();
    expect(gates.find((i) => i.key.at === 1)?.expireAfterSeconds).toBe(
      24 * 60 * 60,
    );
    const hooks = await m.WebhookEvent.collection.indexes();
    expect(hooks.find((i) => i.key.expiresAt === 1)?.expireAfterSeconds).toBe(
      0,
    );
    // Round 2, #10: the person-wide purge's queries, one index each.
    const single = async (name: string, field: string) =>
      (await m[name].collection.indexes()).some(
        (i) => Object.keys(i.key).length === 1 && i.key[field] === 1,
      );
    for (const [name, field] of [
      ['BlockVersion', 'suggestedBy'],
      ['BlockVersion', 'authorUserId'],
      ['CommentVersion', 'authorUserId'],
      ['ModerationLogEntry', 'actorUserId'],
      ['ModerationLogEntry', 'targetId'],
      ['AccountDeletion', 'userId'],
      ['AccountDeletion', 'purgeAfter'],
      // Round 3, L-4.
      ['Comment', 'authorUserId'],
      ['Comment', 'linkedUserId'],
      ['Comment', 'suggestion.decidedBy'],
      ['VoteHistoryEntry', 'voterUserId'],
      ['AdminInboxEntry', 'subjectUserId'],
      ['NotificationQueueRow', 'actorUserId'],
      ...PERSON_DETAIL_KEYS.map((key) => [
        'ModerationLogEntry',
        `details.${key}`,
      ]),
    ]) {
      expect([name, field, await single(name, field)]).toEqual([
        name,
        field,
        true,
      ]);
    }
    // Round 4, #6: the purge's plain-equality queries USE their index.
    const plain: Array<[string, string]> = [
      ['Comment', 'authorUserId'],
      ['Comment', 'linkedUserId'],
      ['Comment', 'suggestion.decidedBy'],
      ['BlockVersion', 'suggestedBy'],
      ['NotificationQueueRow', 'actorUserId'],
      ...PERSON_DETAIL_KEYS.map(
        (key) => ['ModerationLogEntry', `details.${key}`] as [string, string],
      ),
    ];
    for (const [name, field] of plain) {
      const index = (await m[name].collection.indexes()).find(
        (i) => Object.keys(i.key).length === 1 && i.key[field] === 1,
      );
      expect([name, field, index?.partialFilterExpression]).toEqual([
        name,
        field,
        undefined,
      ]);
      const explained = (await m[name]
        .find({ [field]: 'user_probe' })
        .explain('queryPlanner')) as any;
      const plan = JSON.stringify(explained.queryPlanner.winningPlan);
      expect([
        name,
        field,
        plan.includes('"IXSCAN"'),
        plan.includes('COLLSCAN'),
      ]).toEqual([name, field, true, false]);
    }
  });

  it('proves a removed suggester against the anchors on the real driver (round 4, #2, #3)', async () => {
    const at = new Date('2032-03-01T00:00:00Z');
    const deletedAt = new Date('2027-03-01T00:00:00Z');
    const accountId = new mongoose.Types.ObjectId();
    const profileId = new mongoose.Types.ObjectId();
    await m.AccountDeletion.collection.insertOne({
      _id: accountId,
      userId: 'system:purged:probe',
      at: deletedAt,
      purgeAfter: purgeAfterOf(deletedAt),
      purgeRuns: [new Date(at.getTime() - 3 * 86_400_000), at],
    });
    await m.SocialProfile.collection.insertOne({
      _id: profileId,
      slug: 'probe-live-page',
      displayName: 'Synthetic live',
    });
    await m.ProfileBlock.collection.insertOne({
      blockId: 'blk_probe',
      profileId,
      tabId: 'tab_probe',
    });
    await m.Comment.collection.insertOne({
      commentId: 'c-probe-sugg',
      kind: 'suggestion',
      authorUserId: PURGED_PERSON,
      tabId: 'tab_probe',
      suggestion: { resultSeq: 2 },
      purgedAt: at,
    });
    const version = {
      _id: new mongoose.Types.ObjectId(),
      blockId: 'blk_probe',
      seq: 2,
      text: 'Accepted synthetic wording',
      authorUserId: 'user_probe_owner',
      suggestionId: 'c-probe-sugg',
      createdAt: deletedAt,
      prevHash: '0'.repeat(64),
      hash: '1'.repeat(64),
      purgedAt: at,
    };
    const record = toRecord('block', version);
    const salt = '2'.repeat(64);
    const tsa = makeTestTsa();
    const insertChain = async (
      rows: Array<Record<string, unknown> & { hash: string; createdAt: Date }>,
      anchorId: string,
      builtAt: Date,
    ) => {
      const stored = rows.map((row) => ({
        _id: new mongoose.Types.ObjectId(),
        ...row,
      }));
      await m.CommentVersion.collection.insertMany(stored);
      await m.AnchorLeaf.collection.insertMany(
        stored.map((row) => ({
          _id: leafId('comment', row._id),
          anchorId,
          kind: 'comment',
          versionId: row._id,
          versionHash: row.hash,
          salt,
          versionCreatedAt: row.createdAt,
        })) as never,
      );
      // An unrelated leaf first, so the right entry must be picked.
      const other = new mongoose.Types.ObjectId();
      const leaves = [
        {
          kind: 'comment',
          versionId: other,
          versionHash: '5'.repeat(64),
          leaf: leafHash('5'.repeat(64), salt),
        },
        ...stored.map((row) => ({
          kind: 'comment',
          versionId: row._id,
          versionHash: row.hash,
          leaf: leafHash(row.hash, salt),
        })),
      ];
      // Round 5: an intact tree and a token signed at the anchor's time.
      const root = buildTree(leaves.map((leaf) => leaf.leaf)).root;
      await m.TimestampAnchor.collection.insertOne({
        _id: anchorId,
        status: 'built',
        builtAt,
        cutoff: builtAt,
        leaves,
        merkleRoot: root,
        tsa: {
          status: 'stamped',
          response: tsa.respond(root, { genTime: builtAt }),
        },
        leafCount: stored.length + 1,
      } as never);
      return stored;
    };
    await insertChain(
      accountDeletedRows(accountId, deletedAt, [
        'c-probe-other',
        'c-probe-sugg',
      ]),
      'probe-2027-03-02',
      new Date(deletedAt.getTime() + 200 * 86_400_000),
    );
    const marks = new PurgeMarksService(
      m.SocialProfile,
      m.ProfileBlock,
      m.BeliefTab,
      m.Comment,
      m.CommentVersion,
      m.AnchorLeaf,
      m.TimestampAnchor,
      m.AccountDeletion,
      m.BlockVersion,
    );
    marks.trustedRoots = [tsa.root];
    marks.now = () => new Date(at.getTime() + 2 * 86_400_000);
    await m.BlockVersion.collection.insertOne({ ...version });
    const [redaction] = await insertChain(
      [redactionRow(record, at, accountId)],
      'probe-2032-03-02',
      new Date(at.getTime() + 86_400_000),
    );
    expect(await marks.classify('block', record)).toBe('suggester');
    // The anchor's own leaf disagrees with the claim (H): FAIL.
    await m.TimestampAnchor.collection.updateOne(
      { _id: 'probe-2032-03-02', 'leaves.versionId': redaction._id } as never,
      { $set: { 'leaves.$.versionHash': '7'.repeat(64) } },
    );
    // A new request reads the stored leaves as they are now (round 7, 7).
    marks.beginCheck();
    expect(await marks.classify('block', record)).toBe('invalid');
  });

  it('a comment written while the webhook freezes the list is in it or refused (round 9, F2)', async () => {
    const userId = 'user_race_probe';
    const store = new CommentStore(
      m.Comment,
      m.UserWriteGate,
      m.AccountDeletion,
    );
    type Find = (...args: unknown[]) => { exec: () => Promise<unknown> };
    const comments = m.Comment as unknown as { find: Find };
    const original = comments.find;
    let writer: Promise<unknown> | undefined;
    // The webhook's frozen read: start the write now, inside its transaction.
    comments.find = (...args: unknown[]) => {
      const query = Reflect.apply(original, m.Comment, args);
      const filter = args[0] as { authorUserId?: unknown } | undefined;
      if (filter?.authorUserId === userId && !writer) {
        writer = store
          .createConfirmed(
            {
              commentId: 'c-race-probe',
              profileId: new mongoose.Types.ObjectId(),
              authorUserId: userId,
              body: 'Synthetic race comment',
              source: 'native',
              kind: 'comment',
            },
            () => Promise.resolve({ seq: 1 }),
          )
          .then(
            () => 'written',
            (error: unknown) => error,
          );
        const exec = query.exec;
        query.exec = async () => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return Reflect.apply(exec, query, []);
        };
      }
      return query;
    };
    try {
      await deletion.accountDeleted(userId, new Date());
    } finally {
      comments.find = original;
    }
    const outcome = await writer;
    const account = (await m.AccountDeletion.findOne({ userId }).lean()) as {
      _id: mongoose.Types.ObjectId;
    };
    const listed = (
      await m.CommentVersion.find({
        commentId: accountDeletedKey(account._id),
      }).lean()
    ).flatMap((part) => parseAccountDeleted(String(part.text))!.commentIds);
    const row = await m.Comment.findOne({ commentId: 'c-race-probe' }).lean();
    if (outcome === 'written') {
      expect(listed).toContain('c-race-probe');
    } else {
      expect(outcome).toBeInstanceOf(ForbiddenException);
      expect(row).toBeNull();
    }
    // Measured on this driver: the write waits for the webhook's commit.
    expect(outcome).toBeInstanceOf(ForbiddenException);
  });

  it.each([
    [
      'before the transaction has a snapshot: one attempt',
      false,
      (attempts: number) => expect(attempts).toBe(1),
    ],
    [
      'after its snapshot, before its gate write: it retries',
      true,
      (attempts: number) => expect(attempts).toBeGreaterThan(1),
    ],
  ])(
    'a comment written wholly inside the webhook, %s, is listed (round 10, 3)',
    async (_label, snapshotFirst, checkAttempts) => {
      const userId = `user_race_probe_${snapshotFirst ? 'b' : 'a'}`;
      const commentId = `c-race-${snapshotFirst ? 'b' : 'a'}`;
      const store = new CommentStore(
        m.Comment,
        m.UserWriteGate,
        m.AccountDeletion,
      );
      type Update = (...args: unknown[]) => {
        exec: () => Promise<unknown>;
      };
      const gates = m.UserWriteGate as unknown as { updateOne: Update };
      const original = gates.updateOne;
      let attempts = 0;
      gates.updateOne = (...args: unknown[]) => {
        const query = Reflect.apply(original, m.UserWriteGate, args);
        const session = (args[2] as { session?: mongoose.ClientSession })
          ?.session;
        if (!session) return query;
        attempts += 1;
        if (attempts > 1) return query;
        const exec = query.exec;
        query.exec = async () => {
          if (snapshotFirst) {
            // Attempt 1 reads first, as `ownPage` would: its snapshot is
            // taken before the comment exists.
            await m.SocialProfile.findOne({ ownerUserId: userId })
              .session(session)
              .lean()
              .exec();
          }
          await store.createConfirmed(
            {
              commentId,
              profileId: new mongoose.Types.ObjectId(),
              authorUserId: userId,
              body: 'Synthetic race comment',
              source: 'native',
              kind: 'comment',
            },
            () => Promise.resolve({ seq: 1 }),
          );
          return Reflect.apply(exec, query, []);
        };
        return query;
      };
      try {
        await deletion.accountDeleted(userId, new Date());
      } finally {
        gates.updateOne = original;
      }
      const account = (await m.AccountDeletion.findOne({ userId }).lean()) as {
        _id: mongoose.Types.ObjectId;
      };
      const listed = (
        await m.CommentVersion.find({
          commentId: accountDeletedKey(account._id),
        }).lean()
      ).flatMap((part) => parseAccountDeleted(String(part.text))!.commentIds);
      expect(listed).toContain(commentId);
      checkAttempts(attempts);
    },
  );
});

describeStandalone('page deletion on a standalone MongoDB', () => {
  let conn: mongoose.Connection;
  beforeAll(async () => {
    conn = await mongoose.createConnection(String(standaloneUri)).asPromise();
    await conn.dropDatabase();
  });
  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it('refuses with a plain 503, changing nothing', async () => {
    const profiles = conn.model('SocialProfile', MANAGED_SCHEMAS[0].schema);
    await profiles.collection.insertOne({
      slug: 'quiet-fern',
      displayName: 'Synthetic',
      ownerUserId: 'user_sa',
      reviewStatus: 'approved',
    });
    const queue = conn.model(
      'NotificationQueueRow',
      MANAGED_SCHEMAS.find((s) => s.name === 'NotificationQueueRow')!.schema,
    );
    const service = new PageDeletionService(
      conn,
      profiles as never,
      queue as never,
      new ModerationLogService(
        conn.model(
          'ModerationLogEntry',
          MANAGED_SCHEMAS.find((s) => s.name === 'ModerationLogEntry')!.schema,
        ) as never,
      ),
      conn.model(
        'AccountDeletion',
        MANAGED_SCHEMAS.find((s) => s.name === 'AccountDeletion')!.schema,
      ) as never,
      {} as never,
      {} as never,
      {} as never,
      { endAllFor: () => Promise.resolve() } as never,
    );
    await expect(
      service.deleteOwn('user_sa', 'quiet-fern'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(
      await profiles.countDocuments({ deletedAt: { $exists: true } }),
    ).toBe(0);
  });
});
