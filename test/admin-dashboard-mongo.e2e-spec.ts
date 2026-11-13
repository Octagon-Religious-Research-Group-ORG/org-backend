/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
// The admin dashboard (Chunk 12) against a REAL MongoDB replica set: the
// transactions that keep a decision and its log entry together, the unique
// keys behind "one EaM request per member" and "one role change at a time",
// and what a removal does to the rest of the site. Needs MONGO_TEST_URI (a
// throwaway replica-set database; it is dropped). Without it the suite is
// reported as SKIPPED, never as passed. Synthetic data only.
import { ConflictException } from '@nestjs/common';
import mongoose, { type Model, Types } from 'mongoose';
import { AdminInboxService } from '../src/admin-inbox/admin-inbox.service';
import { MANAGED_SCHEMAS } from '../src/db/managed-schemas';
import { AdminLogService } from '../src/members/admin/admin-log.service';
import {
  AdminMembersService,
  NOT_REMOVABLE,
  PAGE_CHANGED,
} from '../src/members/admin/admin-members.service';
import {
  AdminRolesService,
  ROLE_CHANGE_BUSY,
  ROLE_LOCK_KEY,
} from '../src/members/admin/admin-roles.service';
import { EamRequestsService } from '../src/members/admin/eam-requests.service';
import { MembersService } from '../src/members/members.service';
import { decideProfileAccess } from '../src/members/profile-access';
import { ModerationLogService } from '../src/moderation/moderation-log.service';

const uri = process.env.MONGO_TEST_URI;
const describeWithMongo = uri ? describe : describe.skip;

const ADMIN = 'user_admin_a';
const request = (userId?: string) =>
  ({
    headers: userId ? { authorization: `Bearer ${userId}` } : {},
    ...(userId ? { auth: { payload: { sub: userId } } } : {}),
  }) as never;

describeWithMongo('admin dashboard on a real MongoDB', () => {
  jest.setTimeout(30_000);
  let conn: mongoose.Connection;
  const m = {} as Record<string, Model<any>>;
  let members: MembersService;
  let admin: AdminMembersService;
  let inbox: AdminInboxService;
  let eam: EamRequestsService;
  let logView: AdminLogService;
  let pageNumber = 0;

  /** A fresh member page owned by a fresh account. */
  const memberPage = async (extra: Record<string, unknown> = {}) => {
    pageNumber += 1;
    const _id = new Types.ObjectId();
    const owner = `user_member_${pageNumber}`;
    await m.SocialProfile.collection.insertOne({
      _id,
      slug: `member-${pageNumber}`,
      displayName: `Member ${pageNumber}`,
      visibility: 'public',
      reviewStatus: 'approved',
      anonymous: false,
      source: 'native',
      ownerUserId: owner,
      imageIds: [],
      contacts: [],
      createdAt: new Date(),
      ...extra,
    });
    return { _id, slug: `member-${pageNumber}`, owner };
  };
  const statusOf = async (_id: Types.ObjectId) =>
    await m.SocialProfile.findOne({ _id }).lean();
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
    const log = new ModerationLogService(m.ModerationLogEntry);
    inbox = new AdminInboxService(
      m.AdminInboxEntry,
      m.SocialProfile,
      conn,
      log,
    );
    admin = new AdminMembersService(m.SocialProfile, conn, log, inbox);
    eam = new EamRequestsService(m.SocialProfile, inbox);
    logView = new AdminLogService(m.ModerationLogEntry, m.SocialProfile);
  });

  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it('runs on a replica set (transactions are what this suite tests)', async () => {
    const hello = await conn.db!.admin().command({ hello: 1 });
    expect(hello.setName).toBeTruthy();
  });

  it('declares the new indexes db:indexes creates', async () => {
    const inboxIndexes = await m.AdminInboxEntry.collection.indexes();
    const byKey = new Map(inboxIndexes.map((i) => [JSON.stringify(i.key), i]));
    expect(byKey.get('{"status":1,"createdAt":-1}')).toBeDefined();
    expect(byKey.get('{"dedupeKey":1}')).toMatchObject({
      unique: true,
      partialFilterExpression: { dedupeKey: { $type: 'string' } },
    });
    const pageIndexes = await m.SocialProfile.collection.indexes();
    expect(
      pageIndexes.some(
        (i) => JSON.stringify(i.key) === '{"reviewStatus":1,"createdAt":1}',
      ),
    ).toBe(true);
  });

  it('hides a removed page from everyone but admins, and restores it exactly', async () => {
    const page = await memberPage({ visibility: 'members' });
    await admin.remove(ADMIN, page.slug, 'Synthetic: spam');
    const removed = await statusOf(page._id);
    expect(removed.reviewStatus).toBe('removed');
    expect(removed.removal).toMatchObject({
      by: ADMIN,
      reason: 'Synthetic: spam',
      previousStatus: 'approved',
    });
    // The owner is no longer a member: no comments, no votes, no edits.
    const owner = await members.resolveViewer(request(page.owner));
    expect(owner.kind).toBe('signed-in');
    expect(decideProfileAccess(owner, removed).level).toBe('none');
    const adminViewer = await members.resolveViewer(request(ADMIN));
    expect(decideProfileAccess(adminViewer, removed).level).toBe('full');
    const { members: directory } = await members.directory(
      await members.resolveViewer(request('user_admin_b')),
    );
    expect(directory.map((card) => card.slug)).not.toContain(page.slug);
    // Nothing was deleted.
    expect(await m.SocialProfile.countDocuments({ _id: page._id })).toBe(1);

    await expect(
      admin.restore('user_admin_b', page.slug, 'Synthetic: mistake'),
    ).resolves.toEqual({ reviewStatus: 'approved' });
    const back = await statusOf(page._id);
    expect(back.reviewStatus).toBe('approved');
    expect(back.removal).toBeUndefined();
    expect((await members.resolveViewer(request(page.owner))).kind).toBe(
      'named-member',
    );
    expect(await actionsFor(String(page._id))).toEqual([
      'page.removed',
      'page.restored',
    ]);
  });

  it('approves a waiting page and closes its inbox notice, together', async () => {
    const page = await memberPage({ reviewStatus: 'pending' });
    await inbox.notifyPageSubmitted(page.owner, page._id);
    await inbox.notifyPageSubmitted(page.owner, page._id);
    expect(
      await m.AdminInboxEntry.countDocuments({ profileId: page._id }),
    ).toBe(1);
    await admin.approve(ADMIN, page.slug);
    expect((await statusOf(page._id)).reviewStatus).toBe('approved');
    const notice = await m.AdminInboxEntry.findOne({
      profileId: page._id,
    }).lean();
    expect(notice).toMatchObject({ status: 'handled', handledBy: ADMIN });
    expect(await actionsFor(String(page._id))).toEqual(['page.approved']);
  });

  it('writes neither the change nor its notice when the log entry fails', async () => {
    const page = await memberPage({ reviewStatus: 'pending' });
    await inbox.notifyPageSubmitted(page.owner, page._id);
    const failingLog = {
      record: () => Promise.reject(new Error('synthetic log failure')),
    };
    const broken = new AdminMembersService(
      m.SocialProfile,
      conn,
      failingLog as never,
      inbox,
    );
    await expect(broken.approve(ADMIN, page.slug)).rejects.toThrow(
      'synthetic log failure',
    );
    expect((await statusOf(page._id)).reviewStatus).toBe('pending');
    expect(
      (await m.AdminInboxEntry.findOne({ profileId: page._id }).lean()).status,
    ).toBe('open');
  });

  it('lets exactly one of two simultaneous removals through', async () => {
    const page = await memberPage();
    const results = await Promise.allSettled([
      admin.remove(ADMIN, page.slug, 'first'),
      admin.remove('user_admin_b', page.slug, 'second'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
    expect([NOT_REMOVABLE, PAGE_CHANGED]).toContain(
      (rejected[0].reason as Error).message,
    );
    expect(await actionsFor(String(page._id))).toEqual(['page.removed']);
  });

  it('rejects a waiting page so it can be restored to waiting', async () => {
    const page = await memberPage({ reviewStatus: 'pending' });
    await admin.reject(ADMIN, page.slug, 'Synthetic: not a real page');
    expect((await statusOf(page._id)).removal.previousStatus).toBe('pending');
    await expect(
      admin.restore('user_admin_b', page.slug, 'Synthetic: second look'),
    ).resolves.toEqual({ reviewStatus: 'pending' });
  });

  it('takes one EaM request per member, until an admin resets it', async () => {
    const page = await memberPage();
    const viewer = await members.resolveViewer(request(page.owner));
    const asker = { ...viewer, userId: page.owner };
    await eam.request(asker, 'Synthetic note');
    await expect(eam.request(asker, undefined)).rejects.toThrow(
      ConflictException,
    );
    // Two windows at once: still exactly one.
    const other = await memberPage();
    const otherViewer = {
      ...(await members.resolveViewer(request(other.owner))),
      userId: other.owner,
    };
    const both = await Promise.allSettled([
      eam.request(otherViewer, undefined),
      eam.request(otherViewer, undefined),
    ]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const entry = await m.AdminInboxEntry.findOne({
      subjectUserId: page.owner,
      kind: 'eam-request',
    }).lean();
    await inbox.resetEam(ADMIN, String(entry._id));
    expect((await eam.status(asker)).mayRequest).toBe(true);
    await expect(eam.request(asker, undefined)).resolves.toMatchObject({
      block: 'already-requested',
    });
    expect(
      await m.AdminInboxEntry.countDocuments({
        subjectUserId: page.owner,
        kind: 'eam-request',
      }),
    ).toBe(2);
    const { entries } = await inbox.list('handled', 1);
    expect(entries.some((e) => e.entryId === String(entry._id))).toBe(true);
    expect(await actionsFor(String(entry._id))).toEqual(['eam.reset']);
  });

  it('runs one role change at a time across callers, and frees the lock', async () => {
    let releaseFirst: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (releaseFirst = resolve));
    let calls = 0;
    const roles = new AdminRolesService(
      { getOrThrow: () => 'https://org.example' } as never,
      {} as never,
      { getIdentity: () => Promise.resolve({}) } as never,
      {
        setRole: async () => {
          calls += 1;
          if (calls === 1) await held;
        },
      } as never,
      {} as never,
      m.OrgSetting,
      m.SocialProfile,
    );
    const first = roles.promote(ADMIN, 'user_new_1', 'r');
    // Let the first take the lock before the second asks.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(roles.promote(ADMIN, 'user_new_2', 'r')).rejects.toThrow(
      ROLE_CHANGE_BUSY,
    );
    releaseFirst();
    await expect(first).resolves.toEqual({ role: 'admin' });
    expect(await m.OrgSetting.countDocuments({ key: ROLE_LOCK_KEY })).toBe(0);
    await expect(roles.promote(ADMIN, 'user_new_3', 'r')).resolves.toEqual({
      role: 'admin',
    });
  });

  it('takes over a lock left by a role change that died', async () => {
    await m.OrgSetting.collection.insertOne({
      key: ROLE_LOCK_KEY,
      value: 'dead-change',
      updatedBy: ADMIN,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const roles = new AdminRolesService(
      { getOrThrow: () => 'https://org.example' } as never,
      {} as never,
      { getIdentity: () => Promise.resolve({}) } as never,
      { setRole: () => Promise.resolve() } as never,
      {} as never,
      m.OrgSetting,
      m.SocialProfile,
    );
    await expect(roles.promote(ADMIN, 'user_new_4', 'r')).resolves.toEqual({
      role: 'admin',
    });
    expect(await m.OrgSetting.countDocuments({ key: ROLE_LOCK_KEY })).toBe(0);
  });

  it('reads the log newest first, with names, a page at a time', async () => {
    await m.SocialProfile.collection.insertOne({
      _id: new Types.ObjectId(),
      slug: 'the-admin',
      displayName: 'Synthetic Admin',
      visibility: 'public',
      reviewStatus: 'approved',
      source: 'native',
      ownerUserId: ADMIN,
    });
    const { entries } = await logView.page(1);
    expect(entries.length).toBeGreaterThan(3);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1].at >= entries[i].at).toBe(true);
    }
    expect(entries.find((e) => e.actorUserId === ADMIN)?.actorName).toBe(
      'Synthetic Admin',
    );
  });

  it('keeps the moderation log append-only', async () => {
    await expect(
      m.ModerationLogEntry.updateMany({}, { reason: 'rewritten' }).exec(),
    ).rejects.toThrow();
  });
});
