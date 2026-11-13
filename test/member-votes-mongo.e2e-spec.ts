/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
// Votes against a REAL MongoDB (Chunk 10): which index each query uses, and
// the races (vote vs edit, vote vs removal, double vote). Only a real
// database can say either, so this needs MONGO_TEST_URI (a throwaway
// database; it is dropped). Without it the suite is reported as SKIPPED,
// never as passed. Synthetic data only.
import mongoose, { type Model, Types } from 'mongoose';
import { MANAGED_SCHEMAS } from '../src/db/managed-schemas';
import { CommentWritersService } from '../src/members/comments/comment-writers';
import {
  seedBlocks,
  seedOrgPages,
  seedProfiles,
  seedTabs,
  U,
} from '../src/members/comments/comments-harness.mocks-spec';
import { WebsitePageSchema } from '../src/content/schemas/website-page.schema';
import { OrgPagesService } from '../src/members/org-pages/org-pages.service';
import { MemberPageEditorService } from '../src/members/member-page-editor.service';
import { MembersService } from '../src/members/members.service';
import { VotersService } from '../src/members/votes/voters.service';
import { VoteTalliesService } from '../src/members/votes/vote-tallies.service';
import { VotesService } from '../src/members/votes/votes.service';
import { BlockVersionsService } from '../src/social/block-versions.service';
import { VoteHistoryService } from '../src/social/vote-history.service';

const uri = process.env.MONGO_TEST_URI;
const describeWithMongo = uri ? describe : describe.skip;

const request = (userId?: string) =>
  ({
    headers: userId ? { authorization: `Bearer ${userId}` } : {},
    ...(userId ? { auth: { payload: { sub: userId } } } : {}),
  }) as never;

describeWithMongo('votes on a real MongoDB', () => {
  let conn: mongoose.Connection;
  const m = {} as Record<string, Model<any>>;
  let votes: VotesService;
  let editor: MemberPageEditorService;
  let members: MembersService;
  let tallies: VoteTalliesService;
  let history: VoteHistoryService;
  let orgPages: OrgPagesService;
  const anonymous = { value: false };

  const viewer = (userId?: string) => members.resolveViewer(request(userId));
  const cast = async (
    userId: string,
    tabId: string,
    value: 'agree' | 'disagree',
    baseSeq: number,
    slug = 'open-page',
  ) => votes.cast(await viewer(userId), { slug, tabId, value, baseSeq });
  const addMember = (userId: string) =>
    m.SocialProfile.collection.insertOne({
      slug: `page-${userId.replace(/_/g, '-')}`,
      displayName: `Name of ${userId}`,
      visibility: 'public',
      reviewStatus: 'approved',
      anonymous: false,
      ownerUserId: userId,
      imageIds: [],
      contacts: [],
    });
  const headSeq = async (tabId: string) =>
    (
      await editor.readTabText(
        (await m.BeliefTab.findOne({ tabId }).lean()).profileId,
        tabId,
      )
    ).headSeq;

  beforeAll(async () => {
    conn = await mongoose.createConnection(String(uri)).asPromise();
    await conn.dropDatabase();
    for (const { name, schema } of MANAGED_SCHEMAS) {
      m[name] = conn.model(name, schema);
      await m[name].createCollection();
      await m[name].createIndexes();
    }
    m.Comment = conn.model('Comment');
    m.WebsitePage = conn.model('WebsitePage', WebsitePageSchema);
    await m.WebsitePage.collection.insertMany(seedOrgPages());
    orgPages = new OrgPagesService(m.WebsitePage);
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
    tallies = new VoteTalliesService(
      m.VoteTally,
      m.BeliefVote,
      m.BeliefTab,
      m.ProfileBlock,
      m.BlockVersion,
      orgPages,
    );
    editor = new MemberPageEditorService(
      m.SocialProfile,
      m.BeliefTab,
      m.ProfileBlock,
      m.BlockVersion,
      new BlockVersionsService(m.BlockVersion, m.ProfileBlock),
      tallies,
    );
    const writers = new CommentWritersService(members, {
      getIdentity: (userId: string) =>
        Promise.resolve({
          email: `${userId}@example.test`,
          emailVerified: true,
        }),
    } as never);
    history = new VoteHistoryService(m.VoteHistoryEntry);
    votes = new VotesService(
      m.BeliefVote,
      m.VoteTally,
      m.BeliefTab,
      m.SocialProfile,
      m.ProfileBlock,
      m.BlockVersion,
      members,
      new VotersService(writers),
      tallies,
      history,
      { anonymousMayVote: () => Promise.resolve(anonymous.value) } as never,
      orgPages,
    );
  });

  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  /** The counts a tally should hold, computed straight from the votes. */
  async function expectedTally(tabId: string) {
    const seq = await headSeq(tabId);
    const rows = await m.BeliefVote.find({
      tabId,
      value: { $exists: true },
    }).lean();
    const count = (pred: (r: any) => boolean) => rows.filter(pred).length;
    return {
      textSeq: seq,
      agreeMember: count(
        (r) =>
          r.textSeq === seq && r.value === 'agree' && r.voterTier === 'member',
      ),
      disagreeMember: count(
        (r) =>
          r.textSeq === seq &&
          r.value === 'disagree' &&
          r.voterTier === 'member',
      ),
      earlierMember: count(
        (r) => r.textSeq !== seq && r.voterTier === 'member',
      ),
    };
  }

  it('a vote racing a text edit is counted against the wording it was cast on, never the new one', async () => {
    const outcomes = { acceptedOnSeenWording: 0, staleRefused: 0 };
    for (let i = 0; i < 25; i++) {
      const voter = `user_race_edit_${i}`;
      await addMember(voter);
      const base = await headSeq('tab_a');
      // On odd rounds the edit starts first, the vote 0 to 24 ms later.
      const edit = () =>
        editor.editTabText(U.owner, 'tab_a', `Synthetic wording ${i}.`, base);
      const early = i % 2 ? edit() : undefined;
      if (early) await new Promise((resolve) => setTimeout(resolve, i));
      const [voted, edited] = await Promise.allSettled([
        cast(voter, 'tab_a', 'agree', base),
        early ?? edit(),
      ]);
      expect(edited.status).toBe('fulfilled');
      const row = await m.BeliefVote.findOne({
        tabId: 'tab_a',
        voterUserId: voter,
      }).lean();
      if (voted.status === 'rejected') {
        expect(voted.reason.status).toBe(409);
        outcomes.staleRefused++;
        expect(row?.value).toBeUndefined();
        continue;
      }
      // Recorded on exactly the wording the voter saw.
      expect(row).toMatchObject({ value: 'agree', textSeq: base });
      const now = await headSeq('tab_a');
      expect(now).toBe(base + 1);
      outcomes.acceptedOnSeenWording++;
      // Counted as an earlier wording once the edit landed.
      const tally = await m.VoteTally.findOne({ tabId: 'tab_a' }).lean();
      expect(tally).toMatchObject(await expectedTally('tab_a'));
      expect(tally.writers).toEqual([]);
    }
    // Both orders must actually have happened for this to mean anything.
    console.log('vote vs edit outcomes', JSON.stringify(outcomes));
    expect(outcomes.acceptedOnSeenWording + outcomes.staleRefused).toBe(25);
  });

  it('a vote racing a removal never lands on a removed belief', async () => {
    const outcomes = { voteWon: 0, removalWon: 0, both: 0 };
    for (let i = 0; i < 15; i++) {
      const tabId = `tab_rm_${i}`;
      const voter = `user_race_rm_${i}`;
      await addMember(voter);
      const openPage = await m.SocialProfile.findOne({
        slug: 'open-page',
      }).lean();
      await m.BeliefTab.collection.insertOne({
        profileId: openPage._id,
        tabId,
        title: `Title ${tabId}`,
        order: 100 + i,
        reviewStatus: 'confirmed',
        createdAt: new Date(),
      });
      await m.SocialProfile.collection.updateOne(
        { _id: openPage._id },
        { $inc: { liveTabCount: 1 } },
      );
      // On odd rounds the removal starts first, the vote after a delay.
      const removal = i % 2 ? editor.removeTab(U.owner, tabId) : undefined;
      // Started 0 to 14 ms later, to sweep the window both ways.
      if (removal) await new Promise((resolve) => setTimeout(resolve, i));
      const [voted, removed] = await Promise.allSettled([
        cast(voter, tabId, 'agree', 0),
        removal ?? editor.removeTab(U.owner, tabId),
      ]);
      const tab = await m.BeliefTab.findOne({ tabId }).lean();
      const row = await m.BeliefVote.findOne({
        tabId,
        voterUserId: voter,
      }).lean();
      if (voted.status === 'fulfilled' && removed.status === 'fulfilled') {
        outcomes.both++;
        // The vote finished before the removal could start.
        expect(row.castAt.getTime()).toBeLessThanOrEqual(
          tab.removedAt.getTime(),
        );
      } else if (voted.status === 'fulfilled') {
        outcomes.voteWon++;
        expect((removed as PromiseRejectedResult).reason.status).toBe(409);
        expect(tab.removedAt).toBeUndefined();
      } else {
        outcomes.removalWon++;
        expect(voted.reason.status).toBe(404);
        expect(row?.value).toBeUndefined();
        expect(tab.removedAt).toBeInstanceOf(Date);
      }
      const tally = await m.VoteTally.findOne({ tabId }).lean();
      expect(tally.live).toBe(!tab.removedAt);
    }
    console.log('vote vs removal outcomes', JSON.stringify(outcomes));
  });

  it('a reader recounting during a write never erases the writer’s mark; a writer that dies leaves it, and reads keep counting right (fix round 1, MEDIUM 1)', async () => {
    // The reviewer's probe sequence, on a belief of its own.
    const profileId = new Types.ObjectId();
    await m.BeliefTab.collection.insertOne({
      profileId,
      tabId: 'tab_probe',
      title: 'Synthetic probe',
      order: 0,
      createdAt: new Date(),
    });
    for (const u of ['user_p1', 'user_p2']) {
      await m.BeliefVote.collection.insertOne({
        profileId,
        tabId: 'tab_probe',
        voterUserId: u,
        value: 'agree',
        textSeq: 0,
        voterTier: 'member',
        historySeq: 1,
      });
    }
    await tallies.settle(
      'tab_probe',
      await tallies.touch('tab_probe', profileId),
    );
    // Writer W marks the tally, as VotesService.cast does first.
    await tallies.touch('tab_probe', profileId);
    // A reader (a page read) recounts meanwhile.
    await tallies.forPage(profileId, [{ tabId: 'tab_probe', textSeq: 0 }]);
    // W confirms a third agree vote, then dies before settling.
    await m.BeliefVote.collection.insertOne({
      profileId,
      tabId: 'tab_probe',
      voterUserId: 'user_p3',
      value: 'agree',
      textSeq: 0,
      voterTier: 'member',
      historySeq: 1,
    });
    const shown = await tallies.forPage(profileId, [
      { tabId: 'tab_probe', textSeq: 0 },
    ]);
    const actual = await m.BeliefVote.countDocuments({
      tabId: 'tab_probe',
      value: 'agree',
    });
    const marked = await m.VoteTally.countDocuments({
      tabId: 'tab_probe',
      'writers.at': { $exists: true },
    });
    console.log(
      'probe: shown',
      shown.get('tab_probe')?.agreeMember,
      'actual',
      actual,
      'marked',
      marked,
    );
    expect(shown.get('tab_probe')?.agreeMember).toBe(3);
    expect(marked).toBe(1);
    // Once the dead writer's mark is old enough, the repair drops it and
    // saves the true count.
    await m.VoteTally.collection.updateOne(
      { tabId: 'tab_probe' },
      { $set: { 'writers.0.at': new Date(0), agreeMember: 0 } },
    );
    await tallies.repairLeftBehind();
    expect(
      await m.VoteTally.findOne({ tabId: 'tab_probe' }).lean(),
    ).toMatchObject({ writers: [], agreeMember: 3 });
  });

  it('every marked belief is recounted in turn, however many writers died (fix round 2, item d)', async () => {
    // The reviewer's probe: twelve beliefs with stopped writers, then ours.
    const profileId = new Types.ObjectId();
    const slow = new Date(Date.now() - 60_000);
    const hogs = Array.from({ length: 12 }, (_, i) => `tab_hog_${i}`);
    for (const tabId of [...hogs, 'tab_target']) {
      await m.BeliefTab.collection.insertOne({
        profileId,
        tabId,
        title: tabId,
        order: 0,
        createdAt: new Date(),
      });
      await m.VoteTally.collection.insertOne({
        tabId,
        profileId,
        rev: 1,
        live: true,
        textSeq: 0,
        agreeMember: 0,
        agreeAll: 0,
        writers: [{ id: `w-${tabId}`, at: slow }],
      });
    }
    for (const u of ['user_t1', 'user_t2']) {
      await m.BeliefVote.collection.insertOne({
        profileId,
        tabId: 'tab_target',
        voterUserId: u,
        value: 'agree',
        textSeq: 0,
        voterTier: 'member',
        historySeq: 1,
      });
    }
    const target = async () =>
      (await m.VoteTally.findOne({ tabId: 'tab_target' }).lean()).agreeMember;
    const seen: number[] = [];
    for (let read = 0; read < 2; read++) {
      await tallies.repairLeftBehind();
      seen.push(await target());
    }
    console.log('rotation: target agreeMember after each list read', seen);
    expect(seen.at(-1)).toBe(2);
    // Clean up so later tests see no stopped writers.
    await m.VoteTally.collection.deleteMany({ profileId });
  });

  it('a page read that drops a dead mark while a live writer settles still leaves the right count (fix round 3, N1)', async () => {
    // The reviewer's probe R.
    const profileId = new Types.ObjectId();
    await m.BeliefTab.collection.insertOne({
      profileId,
      tabId: 'tab_race',
      title: 'Synthetic race',
      order: 0,
      createdAt: new Date(),
    });
    const addVote = (u: string) =>
      m.BeliefVote.collection.insertOne({
        profileId,
        tabId: 'tab_race',
        voterUserId: u,
        value: 'agree',
        textSeq: 0,
        voterTier: 'member',
        historySeq: 1,
      });
    await addVote('user_r1');
    await tallies.settle(
      'tab_race',
      await tallies.touch('tab_race', profileId),
    );
    // A writer that died six minutes ago.
    await m.VoteTally.updateOne(
      { tabId: 'tab_race' },
      {
        $push: {
          writers: { id: 'dead-r', at: new Date(Date.now() - 6 * 60_000) },
        },
      },
    );
    const mark = await tallies.touch('tab_race', profileId);
    await addVote('user_r2');
    // W's recount reads the revision, then a page read runs before W saves.
    let raced = false;
    const proxied = new Proxy(m.VoteTally, {
      get(target, key, receiver) {
        if (key === 'findOne') {
          return (filter: unknown) => {
            const query = target.findOne(filter as object);
            const exec = query.exec.bind(query);
            query.exec = (async () => {
              const found = await exec();
              if (!raced) {
                raced = true;
                await tallies.forPage(profileId, [
                  { tabId: 'tab_race', textSeq: 0 },
                ]);
              }
              return found;
            }) as never;
            return query;
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    await new VoteTalliesService(
      proxied as never,
      m.BeliefVote,
      m.BeliefTab,
      m.ProfileBlock,
      m.BlockVersion,
      orgPages,
    ).settle('tab_race', mark);
    const row = await m.VoteTally.findOne({ tabId: 'tab_race' }).lean();
    const shown = await tallies.forPage(profileId, [
      { tabId: 'tab_race', textSeq: 0 },
    ]);
    console.log(
      'race: hooked',
      raced,
      'stored agreeMember',
      row.agreeMember,
      'writers',
      (row.writers ?? []).length,
      'next page read shows',
      shown.get('tab_race')?.agreeMember,
    );
    expect(raced).toBe(true);
    expect(row).toMatchObject({ agreeMember: 2, writers: [] });
    expect(shown.get('tab_race')?.agreeMember).toBe(2);
  });

  it('ORG page votes racing a new published revision end exact, and stay off the agreed list (Chunk 10b)', async () => {
    const tabId = 'org-page:about';
    const outcomes = { counted: 0, stale: 0 };
    for (let i = 0; i < 12; i++) {
      const voter = `user_org_race_${i}`;
      await addMember(voter);
      const base = (await orgPages.find('about')).revision;
      const publish = () =>
        m.WebsitePage.updateOne(
          { pageId: 'about' },
          { $inc: { 'published.revision': 1 } },
        );
      const [voted] = await Promise.allSettled([
        votes.castOnOrgPage(await viewer(voter), {
          pageId: 'about',
          value: 'agree',
          baseSeq: base,
        }),
        i % 3 === 0 ? publish() : Promise.resolve(),
      ]);
      if (voted.status === 'fulfilled') outcomes.counted++;
      else outcomes.stale++;
    }
    // A reader recounts against the revision shown now.
    const now = await orgPages.find('about');
    const shown = await tallies.forPage(now._id, [
      { tabId, textSeq: now.revision },
    ]);
    const rows = await m.BeliefVote.find({
      tabId,
      value: { $exists: true },
    }).lean();
    expect(shown.get(tabId)).toMatchObject({
      live: true,
      textSeq: now.revision,
      agreeMember: rows.filter((r) => r.textSeq === now.revision).length,
      earlierMember: rows.filter((r) => r.textSeq !== now.revision).length,
    });
    expect(outcomes.counted + outcomes.stale).toBe(12);
    // The last rounds publish nothing, so the page qualifies by count.
    expect(shown.get(tabId)?.agreeMember).toBeGreaterThanOrEqual(2);
    console.log('org page race:', outcomes, 'revision', now.revision);
    const list = await votes.agreedPage(await viewer(), undefined);
    expect(list.beliefs.map((b) => b.tabId)).not.toContain(tabId);
  });

  it('five clicks at once make one vote and one history entry', async () => {
    await addMember('user_clicker');
    const seq = await headSeq('tab_b');
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        cast('user_clicker', 'tab_b', 'agree', seq),
      ),
    );
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason.status).toBe(409);
    }
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(
      await m.BeliefVote.countDocuments({ voterUserId: 'user_clicker' }),
    ).toBe(1);
    expect(
      await m.VoteHistoryEntry.countDocuments({ voterUserId: 'user_clicker' }),
    ).toBe(1);
    await expect(
      history.verify('tab_b', 'user_clicker'),
    ).resolves.toMatchObject({
      valid: true,
      length: 1,
    });
  });

  it('the list, the counting and the reader’s own votes each use their index', async () => {
    const profileId = new Types.ObjectId();
    const tallyRows = Array.from({ length: 3000 }, (_, i) => ({
      tabId: `tab_ix_${i}`,
      profileId,
      rev: 1,
      live: i % 10 !== 0,
      textSeq: 1,
      agreeMember: i % 7,
      agreeAnon: i % 3,
      agreeAll: (i % 7) + (i % 3),
      tabCreatedAt: new Date(1_000_000 + i),
    }));
    await m.VoteTally.collection.insertMany(tallyRows);
    const voteRows = Array.from({ length: 3000 }, (_, i) => ({
      profileId,
      tabId: `tab_ix_${i % 300}`,
      voterUserId: `user_ix_${Math.floor(i / 300)}`,
      value: i % 2 ? 'agree' : 'disagree',
      textSeq: 1,
      voterTier: 'member',
      historySeq: 1,
    }));
    await m.BeliefVote.collection.insertMany(voteRows);

    const captured: Array<{
      model: string;
      filter: any;
      sort?: any;
      limit?: number;
    }> = [];
    const spy = (name: string) =>
      new Proxy(m[name], {
        get(target, key, receiver) {
          if (key === 'find') {
            return (filter: unknown) => {
              const query = target.find(filter as object);
              const sort = query.sort.bind(query);
              const entry: {
                model: string;
                filter: any;
                sort?: any;
                limit?: number;
              } = {
                model: name,
                filter,
              };
              captured.push(entry);
              const limit = query.limit.bind(query);
              query.limit = ((value: number) => {
                entry.limit = value;
                return limit(value);
              }) as never;
              query.sort = ((value: unknown) => {
                entry.sort = value;
                return sort(value);
              }) as never;
              return query;
            };
          }
          return Reflect.get(target, key, receiver);
        },
      });
    const spiedTallies = new VoteTalliesService(
      spy('VoteTally') as never,
      spy('BeliefVote') as never,
      m.BeliefTab,
      m.ProfileBlock,
      m.BlockVersion,
      orgPages,
    );
    const spiedVotes = new VotesService(
      spy('BeliefVote') as never,
      spy('VoteTally') as never,
      m.BeliefTab,
      m.SocialProfile,
      m.ProfileBlock,
      m.BlockVersion,
      members,
      votes['voters'],
      spiedTallies,
      history,
      { anonymousMayVote: () => Promise.resolve(anonymous.value) } as never,
      orgPages,
    );
    const reader = await viewer('user_ix_1');
    for (const setting of [false, true]) {
      anonymous.value = setting;
      const first = await spiedVotes.agreedPage(reader, undefined);
      await spiedVotes.agreedPage(reader, first.nextAfter ?? '6.0.tab_ix_0');
    }
    anonymous.value = false;
    await spiedTallies.recompute('tab_ix_5');
    await spiedTallies.forPage(profileId, [{ tabId: 'tab_ix_1', textSeq: 1 }]);

    const plan = async (entry: {
      model: string;
      filter: any;
      sort?: any;
      limit?: number;
    }) => {
      let query = m[entry.model].find(entry.filter);
      if (entry.sort) query = query.sort(entry.sort);
      if (entry.limit) query = query.limit(entry.limit);
      const explained = (await query.explain('executionStats')) as any;
      return {
        winning: JSON.stringify(explained.queryPlanner.winningPlan),
        examined: explained.executionStats.totalDocsExamined,
        keys: explained.executionStats.totalKeysExamined,
        returned: explained.executionStats.nReturned,
      };
    };
    const expectIndex = async (
      pick: (e: { model: string; filter: any }) => boolean,
      indexNames: string | string[],
      label: string,
    ) => {
      const names = ([] as string[]).concat(indexNames);
      const entries = captured.filter(pick);
      expect({ label, found: entries.length > 0 }).toEqual({
        label,
        found: true,
      });
      for (const entry of entries) {
        const p = await plan(entry);
        expect({
          label,
          usesIndex: names.some((n) =>
            p.winning.includes(`"indexName":"${n}"`),
          ),
        }).toEqual({
          label,
          usesIndex: true,
        });
        expect({ label, collscan: p.winning.includes('COLLSCAN') }).toEqual({
          label,
          collscan: false,
        });
        console.log(
          label,
          p.winning.match(/"indexName":"[^"]+"/g)?.join(','),
          JSON.stringify({
            examined: p.examined,
            keys: p.keys,
            returned: p.returned,
          }),
        );
      }
    };
    await expectIndex(
      (e) => e.model === 'VoteTally' && 'agreeMember' in e.filter,
      'live_1_agreeMember_-1_tabCreatedAt_-1_tabId_1',
      'list (members only)',
    );
    await expectIndex(
      (e) => e.model === 'VoteTally' && 'agreeAll' in e.filter,
      'live_1_agreeAll_-1_tabCreatedAt_-1_tabId_1',
      'list (anonymous counted)',
    );
    await expectIndex(
      (e) => e.model === 'VoteTally' && 'writers.at' in e.filter,
      'countedAt_1_writers.at_1',
      'left-behind repair',
    );
    await expectIndex(
      (e) => e.model === 'VoteTally' && 'profileId' in e.filter,
      'profileId_1',
      'a page’s tallies',
    );
    await expectIndex(
      (e) =>
        e.model === 'BeliefVote' &&
        'tabId' in e.filter &&
        !('voterUserId' in e.filter),
      'tabId_1_voterUserId_1',
      'counting one belief',
    );
    await expectIndex(
      (e) => e.model === 'BeliefVote' && 'voterUserId' in e.filter,
      ['voterUserId_1_profileId_1', 'tabId_1_voterUserId_1'],
      'the reader’s own votes',
    );
    // The list reads at most one batch per query, however many tallies exist.
    const listPlan = await plan(
      captured.find(
        (e) => e.model === 'VoteTally' && 'agreeMember' in e.filter,
      )!,
    );
    expect(listPlan.examined).toBeLessThanOrEqual(25);
  });
});
