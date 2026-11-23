/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
// Bringing a removed belief back (plan §2e) against a REAL MongoDB: the place
// counter and the races (two returns at once, a return racing a removal).
// Needs MONGO_TEST_URI (a throwaway database; it is dropped). Without it the
// suite is reported as SKIPPED, never as passed. Synthetic data only.
import mongoose, { type Model } from 'mongoose';
import { MANAGED_SCHEMAS } from '../src/db/managed-schemas';
import {
  seedBlocks,
  seedOrgPages,
  seedProfiles,
  seedTabs,
  U,
} from '../src/members/comments/comments-harness.mocks-spec';
import { WebsitePageSchema } from '../src/content/schemas/website-page.schema';
import { MemberPageEditorService } from '../src/members/member-page-editor.service';
import { MyMemberPageService } from '../src/members/my-member-page.service';
import { OrgPagesService } from '../src/members/org-pages/org-pages.service';
import { VoteTalliesService } from '../src/members/votes/vote-tallies.service';
import { BlockVersionsService } from '../src/social/block-versions.service';

const uri = process.env.MONGO_TEST_URI;
const describeWithMongo = uri ? describe : describe.skip;
// A remote throwaway database (Atlas) is slower than a local mongod.
jest.setTimeout(120_000);

describeWithMongo('bringing a removed belief back, on a real MongoDB', () => {
  let conn: mongoose.Connection;
  const m = {} as Record<string, Model<any>>;
  let editor: MemberPageEditorService;
  let page: MyMemberPageService;

  const openPage = () =>
    m.SocialProfile.findOne({ slug: 'open-page' }).lean() as Promise<any>;
  const liveTabs = async () =>
    m.BeliefTab.countDocuments({
      profileId: (await openPage())._id,
      removedAt: { $exists: false },
    });
  const tab = (tabId: string) =>
    m.BeliefTab.findOne({ tabId }).lean() as Promise<any>;

  beforeAll(async () => {
    conn = await mongoose.createConnection(String(uri)).asPromise();
    if (/org-testing|org-website|production/i.test(conn.db!.databaseName)) {
      throw new Error(
        `Refusing to drop ${conn.db!.databaseName}: use a throwaway database`,
      );
    }
    await conn.dropDatabase();
    for (const { name, schema } of MANAGED_SCHEMAS) {
      m[name] = conn.model(name, schema);
      await m[name].createCollection();
      await m[name].createIndexes();
    }
    m.WebsitePage = conn.model('WebsitePage', WebsitePageSchema);
    await m.WebsitePage.collection.insertMany(seedOrgPages());
    const seeded = seedBlocks();
    await m.SocialProfile.collection.insertMany(
      seedProfiles().map((p) =>
        p.slug === 'open-page' ? { ...p, liveTabCount: 2, nextTabOrder: 3 } : p,
      ),
    );
    await m.BeliefTab.collection.insertMany(
      seedTabs().map((t) => ({ ...t, createdAt: new Date() })),
    );
    await m.ProfileBlock.collection.insertMany(seeded.map((s) => s.block));
    await m.BlockVersion.collection.insertMany(seeded.map((s) => s.version));

    const tallies = new VoteTalliesService(
      m.VoteTally,
      m.BeliefVote,
      m.BeliefTab,
      m.ProfileBlock,
      m.BlockVersion,
      new OrgPagesService(m.WebsitePage),
    );
    const versions = new BlockVersionsService(m.BlockVersion, m.ProfileBlock);
    editor = new MemberPageEditorService(
      m.SocialProfile,
      m.BeliefTab,
      m.ProfileBlock,
      m.BlockVersion,
      versions,
      tallies,
    );
    page = new MyMemberPageService(
      m.SocialProfile,
      m.BeliefTab,
      m.ProfileBlock,
      versions,
      {} as never,
      tallies,
    );
  });

  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it('brings a removed belief back once, records the removal, and counts it on the page', async () => {
    const before = await tab('tab_removed');
    await expect(page.restoreTab(U.owner, 'tab_removed')).resolves.toEqual({
      restored: true,
    });
    const after = await tab('tab_removed');
    expect(after.removedAt).toBeUndefined();
    expect(after.removals).toHaveLength(1);
    expect(after.removals[0].removedAt).toEqual(before.removedAt);
    expect(after.removals[0].restoredAt).toBeInstanceOf(Date);
    expect(after.order).toBe(before.order);
    expect((await openPage()).liveTabCount).toBe(3);
    expect(await liveTabs()).toBe(3);
    // A second click is a no-op, not a second place.
    await page.restoreTab(U.owner, 'tab_removed');
    expect((await openPage()).liveTabCount).toBe(3);
  });

  it('two returns at once take one place and write one removal record', async () => {
    await editor.removeTab(U.owner, 'tab_removed');
    expect((await openPage()).liveTabCount).toBe(2);
    const results = await Promise.allSettled([
      page.restoreTab(U.owner, 'tab_removed'),
      page.restoreTab(U.owner, 'tab_removed'),
      page.restoreTab(U.owner, 'tab_removed'),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((await tab('tab_removed')).removals).toHaveLength(2);
    expect(await liveTabs()).toBe(3);
    expect((await openPage()).liveTabCount).toBe(3);
  });

  it('a return racing a removal leaves the counter equal to the real tabs', async () => {
    for (let i = 0; i < 6; i++) {
      await editor.removeTab(U.owner, 'tab_removed').catch(() => undefined);
      await Promise.allSettled([
        page.restoreTab(U.owner, 'tab_removed'),
        editor.removeTab(U.owner, 'tab_removed'),
      ]);
      expect((await openPage()).liveTabCount).toBe(await liveTabs());
    }
  });

  it('only the owner can bring a belief back', async () => {
    await editor.removeTab(U.owner, 'tab_removed').catch(() => undefined);
    await expect(
      page.restoreTab(U.membersOwner, 'tab_removed'),
    ).rejects.toMatchObject({ status: 404 });
    expect((await tab('tab_removed')).removedAt).toBeInstanceOf(Date);
  });
});
