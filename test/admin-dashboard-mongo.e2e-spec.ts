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
  NO_LONGER_ADMIN,
  OWN_PROMOTION,
  ROLE_CHANGE_BUSY,
  ROLE_CHANGE_LOST,
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
    // Waiting again, so the admins' notice is open again (review LOW-2).
    const notice = await m.AdminInboxEntry.findOne({
      profileId: page._id,
    }).lean();
    expect(notice).toMatchObject({ status: 'open', kind: 'page-submitted' });
    expect(notice.handledAt).toBeUndefined();
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

  /**
   * Clerk, simulated: a map of roles. `isAdminNow` reads it fresh, as the
   * real one reads Clerk; gates let a test hold a change at a chosen step.
   */
  const clerkWorld = (admins: string[]) => {
    const roles = new Map<string, string | undefined>(
      admins.map((id) => [id, 'admin']),
    );
    const gates: Record<string, Promise<void> | undefined> = {};
    const pending: Array<{ invitationId: string }> = [];
    const revoked: string[] = [];
    const log = new ModerationLogService(m.ModerationLogEntry);
    const service = new AdminRolesService(
      { getOrThrow: () => 'https://org.example' } as never,
      {
        holdersOf: async () => {
          // Read first, answer late: what a slow Clerk list does.
          const holders = [...roles]
            .filter(([, role]) => role === 'admin')
            .map(([userId]) => ({ userId }));
          await gates.holdersOf;
          return { holders, complete: true };
        },
        invite: (email: string) => {
          const invitationId = `inv_${pending.length + revoked.length + 1}`;
          pending.push({ invitationId });
          return Promise.resolve({
            invitationId,
            email,
            createdAt: new Date().toISOString(),
          });
        },
        pendingInvitations: () =>
          Promise.resolve({ invitations: [...pending], complete: true }),
        revoke: (id: string) => {
          revoked.push(id);
          pending.splice(
            pending.findIndex((p) => p.invitationId === id),
            1,
          );
          return Promise.resolve();
        },
      } as never,
      {
        getIdentity: (id: string) =>
          Promise.resolve(roles.get(id) ? { role: roles.get(id) } : {}),
      } as never,
      {
        setRole: (change: { targetUserId: string; role: string | null }) => {
          roles.set(change.targetUserId, change.role ?? undefined);
          return Promise.resolve();
        },
      } as never,
      log,
      m.OrgSetting,
      m.SocialProfile,
      {
        isAdminNow: (id: string) => Promise.resolve(roles.get(id) === 'admin'),
        allowlist: () => [],
        isAllowlisted: () => false,
        forgetRole: () => Promise.resolve(),
      } as never,
      m.ModerationLogEntry,
    );
    const adminsLeft = () =>
      [...roles].filter(([, role]) => role === 'admin').length;
    return { service, roles, gates, adminsLeft, pending, revoked };
  };

  it('refuses self-promotion, and any change by an admin no longer one in Clerk (HIGH-1)', async () => {
    await m.OrgSetting.deleteMany({ key: ROLE_LOCK_KEY });
    const world = clerkWorld(['user_A', 'user_B']);
    world.roles.set('user_C', undefined);
    await expect(
      world.service.promote('user_C', 'user_C', 'r'),
    ).rejects.toThrow(OWN_PROMOTION);
    // B was demoted, but its token may still be cached as admin.
    world.roles.set('user_B', undefined);
    await expect(
      world.service.promote('user_B', 'user_D', 'r'),
    ).rejects.toThrow(NO_LONGER_ADMIN);
    await expect(
      world.service.invite('user_B', 'd@example.test', 'admin', undefined),
    ).rejects.toThrow(NO_LONGER_ADMIN);
    expect(world.roles.get('user_D')).toBeUndefined();
    expect(world.pending).toEqual([]);
  });

  it('keeps an admin when the lock is aged and taken over mid-change (MEDIUM-1)', async () => {
    await m.OrgSetting.deleteMany({ key: ROLE_LOCK_KEY });
    const world = clerkWorld(['user_A', 'user_B']);
    let releaseA: () => void = () => undefined;
    world.gates.holdersOf = new Promise<void>(
      (resolve) => (releaseA = resolve),
    );
    // A starts demoting B and waits in Clerk's admin list.
    const a = world.service.demote('user_A', 'user_B', 'r').then(
      () => 'done',
      (error: Error) => error.message,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The lock is aged as if A's change had died.
    await m.OrgSetting.collection.updateOne(
      { key: ROLE_LOCK_KEY },
      { $set: { updatedAt: new Date(0) } },
    );
    world.gates.holdersOf = undefined;
    // B takes the lock over and demotes A.
    await expect(
      world.service.demote('user_B', 'user_A', 'r'),
    ).resolves.toEqual({ role: null });
    releaseA();
    // A's fence finds its lock gone: it writes nothing.
    expect(await a).toBe(ROLE_CHANGE_LOST);
    expect(world.adminsLeft()).toBeGreaterThanOrEqual(1);
    expect(world.roles.get('user_B')).toBe('admin');
  });

  it('runs one role change at a time, and frees the lock', async () => {
    await m.OrgSetting.deleteMany({ key: ROLE_LOCK_KEY });
    const world = clerkWorld(['user_A', 'user_B', 'user_C']);
    let release: () => void = () => undefined;
    world.gates.holdersOf = new Promise<void>((resolve) => (release = resolve));
    const first = world.service.demote('user_A', 'user_C', 'r');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(
      world.service.promote('user_B', 'user_D', 'r'),
    ).rejects.toThrow(ROLE_CHANGE_BUSY);
    release();
    await expect(first).resolves.toEqual({ role: null });
    expect(await m.OrgSetting.countDocuments({ key: ROLE_LOCK_KEY })).toBe(0);
  });

  it('takes over a lock left by a role change that died', async () => {
    await m.OrgSetting.deleteMany({ key: ROLE_LOCK_KEY });
    await m.OrgSetting.collection.insertOne({
      key: ROLE_LOCK_KEY,
      value: 'dead-change',
      updatedBy: ADMIN,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const world = clerkWorld(['user_A']);
    await expect(
      world.service.promote('user_A', 'user_new', 'r'),
    ).resolves.toEqual({ role: 'admin' });
    expect(await m.OrgSetting.countDocuments({ key: ROLE_LOCK_KEY })).toBe(0);
  });

  it('withdraws the waiting admin invitations of an admin who is demoted (MEDIUM-3)', async () => {
    await m.OrgSetting.deleteMany({ key: ROLE_LOCK_KEY });
    const world = clerkWorld(['user_inviter', 'user_boss']);
    const admin = await world.service.invite(
      'user_inviter',
      'new-admin@example.test',
      'admin',
      undefined,
    );
    const member = await world.service.invite(
      'user_inviter',
      'new-member@example.test',
      'member',
      undefined,
    );
    await world.service.demote('user_boss', 'user_inviter', 'r');
    expect(world.revoked).toEqual([admin.invitationId]);
    expect(world.pending).toEqual([{ invitationId: member.invitationId }]);
    // The log keeps no readable address (LOW-4).
    const rows = await m.ModerationLogEntry.find({
      targetType: 'invitation',
    }).lean();
    expect(JSON.stringify(rows)).not.toContain('new-admin@example.test');
    expect(JSON.stringify(rows)).not.toContain('new-member@example.test');
    expect(
      rows.some((row: any) => row.details?.emailDomain === 'example.test'),
    ).toBe(true);
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
