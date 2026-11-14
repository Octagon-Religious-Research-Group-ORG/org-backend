/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
// Search (Chunk 15) against a REAL MongoDB, through the real HTTP stack: the
// `$text` engine, the shared visibility filter, grouping, counting and paging,
// the regex last resort, and the Atlas Search failure path. Needs
// MONGO_TEST_URI (a throwaway database; it is dropped) and, for the regex and
// standalone checks, MONGO_STANDALONE_URI. Without them the suite is reported
// as SKIPPED, never as passed. Every name and text here is synthetic.
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import mongoose, { type Model, Types } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AdminAccessService } from '../src/auth/admin-access.service';
import { AdminRoleGuard } from '../src/auth/admin-role.guard';
import { ClerkAuthGuard, OptionalClerkAuthGuard } from '../src/auth/auth.guard';
import { configureHttpApp } from '../src/config/http-app';
import { DEFAULT_THROTTLE } from '../src/config/throttle';
import { WebsitePageSchema } from '../src/content/schemas/website-page.schema';
import { reconcileIndexes } from '../src/db/index-setup';
import { MANAGED_SCHEMAS } from '../src/db/managed-schemas';
import { MembersService } from '../src/members/members.service';
import { OrgSettingsService } from '../src/members/org-settings.service';
import { PictureStore } from '../src/members/picture-store.service';
import { ModerationLogService } from '../src/moderation/moderation-log.service';
import { MemberProfileSchema } from '../src/profiles/schemas/member-profile.schema';
import {
  AdminSearchFragmentsController,
  SearchController,
} from '../src/search/search.controller';
import { SearchEngineService } from '../src/search/search-engine.service';
import { SearchFragmentsService } from '../src/search/search-fragments.service';
import { SearchIndexerService } from '../src/search/search-indexer.service';
import { SearchService } from '../src/search/search.service';
import { computeVersionHash, GENESIS_HASH } from '../src/social/version-chain';
import { optional, required } from './members-test-app';

const uri = process.env.MONGO_TEST_URI;
const standaloneUri = process.env.MONGO_STANDALONE_URI;
const describeWithMongo = uri ? describe : describe.skip;
const describeStandalone = standaloneUri ? describe : describe.skip;

/** Clerk ids. `user_admin*` are admins (see the fake admin access below). */
const U = {
  named: 'user_named_reader',
  anon: 'user_anon_reader',
  nopage: 'user_without_page',
  admin: 'user_admin_reader',
  mothOwner: 'user_moth_owner',
};

/** The word every searchable thing below shares, to count what each reader gets. */
const WORD = 'zephyrite';
/** Stands in for the server secret fragments derive their keys from. */
const SYNTHETIC_SECRET = 'synthetic-server-secret-for-search-tests';
/** Belief results a guest may get for WORD (see `seed`). */
const PUBLIC_HITS = 15;

interface Seeded {
  profiles: object[];
  tabs: object[];
  blocks: object[];
  versions: object[];
}

function versionRow(blockId: string, seq: number, text: string, prev: string) {
  const fields = {
    blockId,
    seq,
    text,
    authorUserId: 'system:import',
    createdAt: new Date(Date.UTC(2026, 10, 1, 10, seq)),
    prevHash: prev,
  };
  return { ...fields, hash: computeVersionHash(fields) };
}

/** A page with one belief tab whose text is `texts` (one version each, in order). */
function addPage(
  into: Seeded,
  slug: string,
  displayName: string,
  title: string,
  texts: string[],
  extra: Record<string, unknown> = {},
) {
  const _id = new Types.ObjectId();
  into.profiles.push({
    _id,
    slug,
    displayName,
    visibility: 'public',
    reviewStatus: 'approved',
    anonymous: false,
    source: 'native',
    imageIds: [],
    contacts: [],
    ...extra,
  });
  const tabId = `tab_${slug}`;
  into.tabs.push({
    profileId: _id,
    tabId,
    title,
    order: 0,
    reviewStatus: 'confirmed',
  });
  const blockId = `blk_${slug}`;
  into.blocks.push({
    profileId: _id,
    blockId,
    section: 'beliefs',
    kind: 'paragraph',
    tabId,
    label: '',
    order: 0,
    currentVersionSeq: texts.length,
  });
  let prev = GENESIS_HASH;
  texts.forEach((text, index) => {
    const row = versionRow(blockId, index + 1, text, prev);
    prev = row.hash;
    into.versions.push(row);
  });
  return { _id, tabId, blockId };
}

function seed() {
  const s: Seeded = { profiles: [], tabs: [], blocks: [], versions: [] };
  // 12 + 1 public beliefs, an anonymous member's public one and a CMS page:
  // PUBLIC_HITS for a guest, so a guest has two result pages.
  for (let n = 1; n <= 12; n += 1) {
    addPage(s, `bulk-${n}`, `Bulk Seeker ${n}`, `Bulk title ${n}`, [
      `A ${WORD} bulk belief number ${n}.`,
    ]);
  }
  const open = addPage(
    s,
    'open-seeker',
    'Quillon Openfield',
    'Lantern doctrine',
    ['An obsoletegloss first wording.', `The ${WORD} lantern guides.`],
    { ownerUserId: 'user_open_owner' },
  );
  addPage(
    s,
    'moth-page',
    'Moth Nickname',
    'Moth thoughts',
    [`A ${WORD} thought from the moth.`],
    { anonymous: true, ownerUserId: U.mothOwner },
  );
  // Members-only and named-members-only: listed by name, text for members.
  addPage(
    s,
    'members-seeker',
    'Marrow Memberly',
    'Velvet secret',
    [`Members-only ${WORD} velvet words.`],
    { visibility: 'members', ownerUserId: 'user_members_owner' },
  );
  addPage(
    s,
    'named-seeker',
    'Nadir Namedonly',
    'Named lattice',
    [`Named-only ${WORD} lattice text.`],
    { visibility: 'named-members', ownerUserId: 'user_named_owner' },
  );
  // Never searchable, for anyone, admins included.
  addPage(
    s,
    'private-seeker',
    'Pallid Privateer',
    'Private cellar',
    [`Private ${WORD} cellar paragraph.`],
    { visibility: 'unlisted', ownerUserId: 'user_private_owner' },
  );
  addPage(
    s,
    'removed-seeker',
    'Rook Removed',
    'Removed spire',
    [`Removed ${WORD} spire text.`],
    {
      reviewStatus: 'removed',
      ownerUserId: 'user_removed_owner',
      removal: {
        at: new Date(0),
        by: U.admin,
        reason: 'Synthetic.',
        previousStatus: 'approved',
      },
    },
  );
  addPage(
    s,
    'pending-seeker',
    'Pemberly Pending',
    'Pending gate',
    [`Pending ${WORD} gate text.`],
    { reviewStatus: 'pending', ownerUserId: 'user_pending_owner' },
  );
  addPage(
    s,
    'deleted-seeker',
    'Dunmore Deleted',
    'Deleted door',
    [`Deleted ${WORD} door text.`],
    { deletedAt: new Date(0), ownerUserId: 'user_deleted_owner' },
  );
  // Review fixes (H1, M1, L1): words only members can read next to words
  // anyone can; public multi-word titles; a public accented word; an imported
  // two-block belief whose first block is about to be edited.
  addPage(
    s,
    'secret-holder',
    'Velour Holder',
    'Hush notes',
    ['A privateterm only members read.'],
    { visibility: 'members', ownerUserId: 'user_secret_owner' },
  );
  addPage(
    s,
    'common-holder',
    'Plain Holder',
    'Silver orchard',
    ['A commonword everybody reads. Copper bell rings.'],
    { ownerUserId: 'user_common_owner' },
  );
  addPage(
    s,
    'cafe-holder',
    'Dawn Holder',
    'Morning rite',
    ['Morning café gathering.'],
    { ownerUserId: 'user_cafe_owner' },
  );
  // Round-3 review: a public belief whose only block is about to go.
  addPage(
    s,
    'quiet-holder',
    'Still Holder',
    'Rest',
    ['A quietphrase rests here.'],
    { ownerUserId: 'user_quiet_owner' },
  );
  const multi = addPage(
    s,
    'multi-holder',
    'Twin Holder',
    'Two parts',
    ['First imported part.'],
    { ownerUserId: 'user_multi_owner' },
  );
  s.blocks.push({
    profileId: multi._id,
    blockId: 'blk_multi-holder-2',
    section: 'beliefs',
    kind: 'paragraph',
    tabId: multi.tabId,
    label: '',
    order: 1,
    currentVersionSeq: 1,
  });
  s.versions.push(
    versionRow(
      'blk_multi-holder-2',
      1,
      'Leftoverword second part.',
      GENESIS_HASH,
    ),
  );
  // A removed tab on a public page.
  s.tabs.push({
    profileId: open._id,
    tabId: 'tab_open_removed',
    title: 'Withdrawn tower',
    order: 1,
    reviewStatus: 'confirmed',
    removedAt: new Date(0),
  });
  s.blocks.push({
    profileId: open._id,
    blockId: 'blk_open_removed',
    section: 'beliefs',
    kind: 'paragraph',
    tabId: 'tab_open_removed',
    label: '',
    order: 0,
    currentVersionSeq: 1,
  });
  s.versions.push(
    versionRow(
      'blk_open_removed',
      1,
      `Withdrawn ${WORD} tower text.`,
      GENESIS_HASH,
    ),
  );
  // The readers' own pages.
  for (const [slug, owner, anonymous] of [
    ['reader-named', U.named, false],
    ['reader-anon', U.anon, true],
  ] as const) {
    s.profiles.push({
      _id: new Types.ObjectId(),
      slug,
      displayName: `Reader ${slug}`,
      visibility: 'unlisted',
      reviewStatus: 'approved',
      anonymous,
      source: 'native',
      ownerUserId: owner,
      imageIds: [],
      contacts: [],
    });
  }
  return { s, open };
}

const fakeAdmin = {
  hasAdminAccess: (req: { auth?: { payload: { sub: string } } }) =>
    Promise.resolve(Boolean(req.auth?.payload.sub.startsWith('user_admin'))),
  isAdminForRead: (req: { auth?: { payload: { sub: string } } }) =>
    Promise.resolve(Boolean(req.auth?.payload.sub.startsWith('user_admin'))),
};

describeWithMongo('search on a real MongoDB', () => {
  jest.setTimeout(60_000);
  let conn: mongoose.Connection;
  const m = {} as Record<string, Model<any>>;
  let app: INestApplication<App>;
  let indexer: SearchIndexerService;
  let engines: SearchEngineService;
  let fragments: SearchFragmentsService;
  let search: SearchService;
  const config = {
    get: (key: string, fallback: unknown) =>
      (
        ({
          SEARCH_FRAGMENT_MIN_SEARCHERS: 2,
          CLERK_SECRET_KEY: SYNTHETIC_SECRET,
        }) as Record<string, unknown>
      )[key] ?? fallback,
  };

  let visitor = 0;
  /** Each call from its own address, so the per-visitor limit stays out of the way. */
  const get = (path: string, userId?: string, ip?: string) => {
    visitor += 1;
    const call = request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set(
        'X-Forwarded-For',
        ip ?? `10.0.${Math.floor(visitor / 250)}.${visitor % 250}`,
      );
    return userId ? call.set('Authorization', `Bearer ${userId}`) : call;
  };
  const find = async (q: string, userId?: string, extra = '') =>
    (
      await get(`/search?q=${encodeURIComponent(q)}${extra}`, userId).expect(
        200,
      )
    ).body;
  /** Every result of a query, across all its pages. */
  const all = async (q: string, userId?: string) => {
    const first = await find(q, userId);
    const pages = Math.ceil(first.total / first.pageSize);
    const rest: any[] = [];
    for (let page = 2; page <= pages; page += 1) {
      rest.push(...(await find(q, userId, `&page=${page}`)).results);
    }
    return { total: first.total, results: [...first.results, ...rest] };
  };
  /** Where Suggested Fragments keep anything at all (counts and pair hashes). */
  const COUNT_COLLECTIONS = ['searchtermwindows', 'searchfragmentpairs'];
  const clearCounts = async () => {
    for (const name of COUNT_COLLECTIONS) {
      await conn.collection(name).deleteMany({});
    }
  };
  const storedCounts = async () => {
    const rows: any[] = [];
    for (const name of COUNT_COLLECTIONS) {
      rows.push(...(await conn.collection(name).find({}).toArray()));
    }
    return rows;
  };
  const slugsOf = (results: any[]) =>
    results.map((result) => result.slug ?? `page:${result.pageId}`).sort();

  beforeAll(async () => {
    conn = await mongoose.createConnection(String(uri)).asPromise();
    await conn.dropDatabase();
    for (const { name, schema } of MANAGED_SCHEMAS) {
      m[name] = conn.model(name, schema);
      await m[name].createCollection();
      await m[name].createIndexes();
    }
    m.WebsitePage = conn.model('WebsitePage', WebsitePageSchema);
    m.MemberProfile = conn.model('MemberProfile', MemberProfileSchema);
    const { s } = seed();
    await m.SocialProfile.collection.insertMany(s.profiles);
    await m.BeliefTab.collection.insertMany(s.tabs);
    await m.ProfileBlock.collection.insertMany(s.blocks);
    await m.BlockVersion.collection.insertMany(s.versions);
    await m.WebsitePage.collection.insertOne({
      pageId: 'research',
      published: {
        revision: 2,
        content: {
          kind: 'reference',
          id: 'research',
          title: 'Research',
          subtitle: 'Synthetic subtitle',
          blocks: [
            { id: 'r1', kind: 'paragraph', text: `A public ${WORD} study.` },
          ],
        },
        publishedAt: new Date('2026-11-01T09:00:00.000Z'),
        publishedBy: 'system:test',
      },
      history: [],
    });
    // The anonymous page's owner has a real name on their account record;
    // search never reads that collection.
    await m.MemberProfile.collection.insertOne({
      auth0Id: U.mothOwner,
      preferredName: 'Zorvath Realname',
      email: 'moth@example.test',
    });
    // A comment a moderator hid: comments are not searched at all.
    await m.Comment.collection.insertOne({
      commentId: 'cmt_hidden',
      profileId: (s.profiles[0] as { _id: Types.ObjectId })._id,
      tabId: 'tab_bulk-1',
      body: 'A quasarblot comment.',
      moderation: 'hidden',
    });

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([DEFAULT_THROTTLE])],
      controllers: [SearchController, AdminSearchFragmentsController],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        Reflector,
        AdminRoleGuard,
        SearchService,
        SearchEngineService,
        SearchIndexerService,
        SearchFragmentsService,
        MembersService,
        ModerationLogService,
        { provide: AdminAccessService, useValue: fakeAdmin },
        {
          provide: ConfigService,
          useValue: config,
        },
        ...[
          'SocialProfile',
          'BeliefTab',
          'ProfileBlock',
          'BlockVersion',
          'Comment',
          'SearchEntry',
          'SearchTermWindow',
          'SearchFragmentHide',
          'SearchFragmentPair',
          'ModerationLogEntry',
          'WebsitePage',
        ].map((name) => ({ provide: getModelToken(name), useValue: m[name] })),
        // Pictures and settings are not part of search.
        { provide: PictureStore, useValue: {} },
        { provide: OrgSettingsService, useValue: {} },
      ],
    })
      .overrideGuard(OptionalClerkAuthGuard)
      .useValue(optional)
      .overrideGuard(ClerkAuthGuard)
      .useValue(required)
      .compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpApp(nest, {
      origins: ['http://localhost'],
      trustProxyHops: 1,
    });
    await nest.init();
    app = nest;
    indexer = moduleRef.get(SearchIndexerService);
    engines = moduleRef.get(SearchEngineService);
    fragments = moduleRef.get(SearchFragmentsService);
    search = moduleRef.get(SearchService);
    await indexer.refresh({ full: true });
  });

  afterAll(async () => {
    await app?.close();
    await conn?.dropDatabase();
    await conn?.close();
  });

  it('declares every search index cleanly, and a local mongod has no Atlas Search', async () => {
    const outcome = await reconcileIndexes([m.SearchEntry], { dryRun: true });
    expect(outcome.status).toBe('ok');
    expect(await engines.engines()).toEqual(['text', 'regex']);
  });

  it('gives a guest exactly the public results, on every page and in the total', async () => {
    const guest = await all(WORD);
    expect(guest.total).toBe(PUBLIC_HITS);
    expect(guest.results).toHaveLength(PUBLIC_HITS);
    const page2 = await find(WORD, undefined, '&page=2');
    expect(page2.results).toHaveLength(PUBLIC_HITS - 10);
    expect(page2.total).toBe(PUBLIC_HITS);
    const text = JSON.stringify(guest.results);
    for (const secret of [
      'velvet',
      'lattice',
      'cellar',
      'spire',
      'gate text',
      'door text',
      'Withdrawn',
      'members-seeker',
      'named-seeker',
      'private-seeker',
      'removed-seeker',
      'pending-seeker',
      'deleted-seeker',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(slugsOf(guest.results)).toContain('page:research');
  });

  it('never returns members-only text to a guest or a signed-in reader without a page', async () => {
    for (const reader of [undefined, U.nopage]) {
      for (const q of ['velvet', 'Velvet secret', 'lattice', 'Named lattice']) {
        expect((await find(q, reader)).total).toBe(0);
      }
      // Its name is listed, like its directory card: the name and nothing else.
      const byName = await find('Marrow', reader);
      expect(byName.results).toEqual([
        expect.objectContaining({
          kind: 'member',
          slug: 'members-seeker',
          displayName: 'Marrow Memberly',
          membersOnly: true,
          snippet: 'Marrow Memberly',
        }),
      ]);
    }
  });

  it('shows members what their membership lets them read, and no more', async () => {
    const named = await all(WORD, U.named);
    expect(named.total).toBe(PUBLIC_HITS + 2);
    expect(slugsOf(named.results)).toEqual(
      expect.arrayContaining(['members-seeker', 'named-seeker']),
    );
    const anon = await all(WORD, U.anon);
    expect(anon.total).toBe(PUBLIC_HITS + 1);
    expect(slugsOf(anon.results)).toContain('members-seeker');
    expect(slugsOf(anon.results)).not.toContain('named-seeker');
    expect((await find('Marrow', U.named)).results[0].membersOnly).toBe(false);
  });

  it('never shows a private, removed, pending or deleted page, admins included', async () => {
    for (const reader of [undefined, U.named, U.admin]) {
      for (const q of [
        'Pallid',
        'cellar',
        'Rook',
        'spire',
        'Pemberly',
        'gate',
        'Dunmore',
        'door',
      ]) {
        expect([reader, q, (await find(q, reader)).total]).toEqual([
          reader,
          q,
          0,
        ]);
      }
    }
    expect((await all(WORD, U.admin)).total).toBe(PUBLIC_HITS + 2);
  });

  it('never shows a removed belief, an old wording or a moderated comment', async () => {
    for (const reader of [undefined, U.named]) {
      expect((await find('Withdrawn tower', reader)).total).toBe(0);
      expect((await find('obsoletegloss', reader)).total).toBe(0);
      expect((await find('quasarblot', reader)).total).toBe(0);
    }
    expect((await find('lantern', U.named)).results[0]).toEqual(
      expect.objectContaining({
        kind: 'belief',
        slug: 'open-seeker',
        title: 'Lantern doctrine',
        matched: 'title',
      }),
    );
  });

  it("never reveals an anonymous page's owner", async () => {
    for (const reader of [undefined, U.named, U.admin]) {
      expect((await find('Zorvath', reader)).total).toBe(0);
      expect((await find('Realname', reader)).total).toBe(0);
      const moth = await find('moth', reader);
      const body = JSON.stringify(moth);
      expect(body).toContain('Moth Nickname');
      expect(body).not.toMatch(/Zorvath|Realname|user_moth_owner|ownerUserId/);
    }
  });

  it('stops showing a page the moment it is made private, before any refresh', async () => {
    expect(slugsOf((await all('Bulk Seeker 3')).results)).toContain('bulk-3');
    await m.SocialProfile.updateOne(
      { slug: 'bulk-3' },
      { $set: { visibility: 'unlisted' } },
    );
    expect(slugsOf((await all('Bulk Seeker 3')).results)).not.toContain(
      'bulk-3',
    );
    expect((await all(WORD)).total).toBe(PUBLIC_HITS - 1);
    await m.SocialProfile.updateOne(
      { slug: 'bulk-3' },
      { $set: { visibility: 'public' } },
    );
  });

  it('drops a stale copy at once and finds the new text after a refresh', async () => {
    await m.SocialProfile.updateOne(
      { slug: 'bulk-4' },
      { $set: { displayName: 'Renamed Seeker' } },
    );
    // The old name is no longer what the page shows: never returned.
    const names = (await all('Bulk Seeker 4')).results.filter(
      (result) => result.kind === 'member',
    );
    expect(slugsOf(names)).not.toContain('bulk-4');
    expect(slugsOf(names)).toContain('bulk-5');
    await indexer.refresh({ full: false });
    expect((await find('Renamed')).results[0].slug).toBe('bulk-4');
  });

  it('sends no-store and varies on Origin and Authorization', async () => {
    const guest = await get(`/search?q=${WORD}`)
      .set('Origin', 'http://localhost')
      .expect(200);
    expect(guest.headers['cache-control']).toBe('no-store');
    expect(guest.headers.vary).toMatch(/Origin/);
    expect(guest.headers.vary).toMatch(/Authorization/);
    const member = await get(`/search?q=${WORD}`, U.named).expect(200);
    expect(member.headers['cache-control']).toBe('private, no-store');
  });

  it('refuses an over-long query and answers a too-short one with nothing', async () => {
    await get(`/search?q=${'a'.repeat(101)}`).expect(400);
    await get(`/search?q=${WORD}&page=51`).expect(400);
    await get(`/search?q=${WORD}&type=comments`).expect(400);
    expect((await find('a')).total).toBe(0);
  });

  it('limits each visitor to 30 searches a minute', async () => {
    for (let n = 0; n < 30; n += 1) {
      await get(`/search?q=${WORD}`, undefined, '10.9.9.9').expect(200);
    }
    await get(`/search?q=${WORD}`, undefined, '10.9.9.9').expect(429);
  });

  it('filters by type', async () => {
    const members = await find('Quillon', undefined, '&type=members');
    expect(members.results.map((r: any) => r.kind)).toEqual(['member']);
    const pages = await find(WORD, undefined, '&type=pages');
    expect(pages.results.map((r: any) => r.pageId)).toEqual(['research']);
    expect((await find('Quillon', undefined, '&type=beliefs')).total).toBe(0);
  });

  it('falls back to $text when $search fails, with the same filter', async () => {
    const spy = jest
      .spyOn(engines, 'engines')
      .mockResolvedValue(['atlas', 'text', 'regex']);
    const failed = jest.spyOn(engines, 'atlasFailed');
    expect((await all(WORD)).total).toBe(PUBLIC_HITS);
    expect(failed).toHaveBeenCalled();
    spy.mockRestore();
    failed.mockRestore();
  });

  it('suggests a term only once enough different searchers used it, and only while it matches public content', async () => {
    // Start from nothing: earlier tests' searches were counted too.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await clearCounts();
    // Recorded after answering; wait for each count to land.
    const search = async (q: string, userId?: string) => {
      const counted = jest.spyOn(fragments, 'record');
      await find(q, userId);
      await counted.mock.results[0]?.value;
      counted.mockRestore();
    };
    await search('lantern', U.named);
    await search('lantern', U.named); // the same searcher again: once
    expect((await get('/search/fragments').expect(200)).body.fragments).toEqual(
      [],
    );
    await search('lantern', U.anon);
    // A members-only word is never counted, however often it is searched.
    await search('velvet', U.named);
    await search('velvet', U.anon);
    await search('velvet', U.admin);
    const rows = await storedCounts();
    expect(rows.map((row: any) => row.term)).toEqual(['lantern']);
    // Aggregates only: nothing that could say who searched.
    expect(Object.keys(rows[0])).not.toEqual(
      expect.arrayContaining(['userId']),
    );
    expect(JSON.stringify(rows)).not.toMatch(/user_|ip:|10\.0\./);
    // No cache clearing anywhere below: each answer must be fresh by itself.
    expect((await get('/search/fragments').expect(200)).body.fragments).toEqual(
      ['lantern'],
    );

    // An admin hides it; the log records it; it stops being suggested.
    await request(app.getHttpServer())
      .post('/api/v1/admin/search-fragments')
      .set('Authorization', `Bearer ${U.named}`)
      .send({ term: 'lantern', hidden: true })
      .expect(403);
    const hidden = await request(app.getHttpServer())
      .post('/api/v1/admin/search-fragments')
      .set('Authorization', `Bearer ${U.admin}`)
      .send({ term: 'Lantern', hidden: true, reason: 'Synthetic reason.' })
      .expect(201);
    expect(hidden.body).toEqual({ term: 'lantern', hidden: true });
    expect((await get('/search/fragments').expect(200)).body.fragments).toEqual(
      [],
    );
    const admin = await get('/admin/search-fragments', U.admin).expect(200);
    expect(admin.body.fragments).toEqual([
      { term: 'lantern', searchers: 2, hidden: true, shown: false },
    ]);
    const log = await m.ModerationLogEntry.find({
      targetType: 'search-fragment',
    }).lean();
    expect(log.map((row: any) => [row.action, row.targetId])).toEqual([
      ['search.fragment.hidden', 'lantern'],
    ]);

    // Shown again, until the page that held the word goes private.
    await request(app.getHttpServer())
      .post('/api/v1/admin/search-fragments')
      .set('Authorization', `Bearer ${U.admin}`)
      .send({ term: 'lantern', hidden: false })
      .expect(201);
    expect((await get('/search/fragments').expect(200)).body.fragments).toEqual(
      ['lantern'],
    );
    await m.SocialProfile.updateOne(
      { slug: 'open-seeker' },
      { $set: { visibility: 'members' } },
    );
    expect((await get('/search/fragments').expect(200)).body.fragments).toEqual(
      [],
    );
    await m.SocialProfile.updateOne(
      { slug: 'open-seeker' },
      { $set: { visibility: 'public' } },
    );
  });

  /** A date in the same 30-day window as `base`, `days` later. */
  const later = (base: Date, days: number) =>
    new Date(base.getTime() + days * 86_400_000);
  /** Past the public list's cache, so only eligibility decides. */
  const uncached = () => new Date(Date.now() + 11 * 60_000);

  it('never suggests a phrase unless every word of it is public (review H1a)', async () => {
    // A guest finds nothing for the members-only word alone...
    expect((await find('privateterm')).total).toBe(0);
    // ...but a search with a public word next to it does find something.
    expect((await find('privateterm commonword')).total).toBeGreaterThan(0);
    for (let n = 1; n <= 4; n += 1) {
      await fragments.record('privateterm commonword', 3, `ip:h1a-${n}`);
      await fragments.record('everybody reads', 1, `ip:h1a-${n}`);
    }
    const now = uncached();
    const terms = (await fragments.adminView(now)).map((row) => row.term);
    expect(terms).not.toContain('privateterm commonword');
    expect(await fragments.fragments(now)).not.toContain(
      'privateterm commonword',
    );
    // A phrase whose every word is public is suggested.
    expect(await fragments.fragments(now)).toContain('everybody reads');
  });

  it('counts one visitor once across the whole window, on any number of days (review H1b)', async () => {
    const day = new Date('2026-11-14T12:00:00Z');
    for (let n = 0; n < 5; n += 1) {
      await fragments.record(
        'copper bell',
        1,
        'ip:same-visitor',
        later(day, n),
      );
    }
    const view = async (at: Date) =>
      (await fragments.adminView(at)).find((row) => row.term === 'copper bell');
    // Five days, one person: below the threshold of two.
    expect(await view(later(day, 4))).toBeUndefined();
    await fragments.record(
      'copper bell',
      1,
      'ip:second-visitor',
      later(day, 5),
    );
    expect(await view(later(day, 5))).toEqual(
      expect.objectContaining({ searchers: 2 }),
    );
  });

  it('never returns a block the page no longer shows after an edit (review M1)', async () => {
    const fresh = jest.spyOn(indexer, 'ensureFresh').mockResolvedValue();
    try {
      expect((await find('leftoverword')).total).toBe(1);
      // An edit writes the whole text into the first block (version 2); the
      // tidy-up that takes block 2 off the page has not run, nor a refresh.
      const first = (await m.BlockVersion.findOne({
        blockId: 'blk_multi-holder',
        seq: 1,
      }).lean()) as { hash: string };
      await m.BlockVersion.collection.insertOne(
        versionRow(
          'blk_multi-holder',
          2,
          'Rewritten whole belief.',
          first.hash,
        ),
      );
      for (const reader of [undefined, U.named]) {
        expect((await find('leftoverword', reader)).total).toBe(0);
      }
    } finally {
      fresh.mockRestore();
    }
  });

  /** A new service, as after the free server sleeps and wakes. */
  const restarted = () =>
    new (SearchFragmentsService as any)(
      m.SearchTermWindow,
      m.SearchFragmentHide,
      search,
      new ModerationLogService(m.ModerationLogEntry),
      config,
      m.SearchFragmentPair,
    ) as SearchFragmentsService;

  it('counts a visitor once across restarts, and stores nothing that names them (review M-A)', async () => {
    const at = new Date('2026-11-20T12:00:00Z');
    for (let wake = 0; wake < 5; wake += 1) {
      await restarted().record(
        'commonword everybody',
        1,
        'ip:restart-visitor',
        at,
      );
    }
    const row = async () =>
      (await restarted().adminView(at)).find(
        (view) => view.term === 'commonword everybody',
      );
    // One person over five wake-ups: below the threshold of two.
    expect(await row()).toBeUndefined();
    await restarted().record(
      'commonword everybody',
      1,
      'ip:second-restart',
      at,
    );
    expect(await row()).toEqual(expect.objectContaining({ searchers: 2 }));
    const stored = JSON.stringify(await storedCounts());
    expect(stored).not.toMatch(/restart|ip:/);
    // Without the server secret, fragments are off: nothing is counted.
    const noSecret = new (SearchFragmentsService as any)(
      m.SearchTermWindow,
      m.SearchFragmentHide,
      search,
      new ModerationLogService(m.ModerationLogEntry),
      {
        get: (key: string, fallback: unknown) =>
          key === 'CLERK_SECRET_KEY' ? '' : fallback,
      },
      m.SearchFragmentPair,
    ) as SearchFragmentsService;
    const before = JSON.stringify(await storedCounts());
    await noSecret.record('commonword everybody', 1, 'ip:third', at);
    expect(JSON.stringify(await storedCounts())).toBe(before);
    expect(await noSecret.fragments(at)).toEqual([]);
  });

  it('never suggests a member name, only belief text and ORG pages (review M-B)', async () => {
    const at = new Date('2026-11-21T12:00:00Z');
    // A public page's name: a guest finds it.
    expect((await find('plain holder')).total).toBeGreaterThan(0);
    for (let n = 1; n <= 3; n += 1) {
      await fragments.record('plain holder', 1, `ip:mb-${n}`, at);
    }
    expect(
      (await fragments.adminView(at)).map((view) => view.term),
    ).not.toContain('plain holder');
  });

  it('drops a suggestion the moment its source goes, refresh or not (round-3 review)', async () => {
    const fresh = jest.spyOn(indexer, 'ensureFresh').mockResolvedValue();
    const suggested = async () =>
      (await get('/search/fragments').expect(200)).body.fragments as string[];
    try {
      await fragments.record('quietphrase', 1, 'ip:quiet-1');
      await fragments.record('quietphrase', 1, 'ip:quiet-2');
      expect(await suggested()).toContain('quietphrase');
      // The tab's only block is taken off the page; no refresh has run.
      await m.ProfileBlock.updateOne(
        { blockId: 'blk_quiet-holder' },
        { $set: { removedAt: new Date() } },
      );
      expect((await find('quietphrase')).total).toBe(0);
      expect(await suggested()).not.toContain('quietphrase');
      // A refresh that only deletes entries changes nothing either.
      await indexer.refresh({ full: false });
      expect(await suggested()).not.toContain('quietphrase');
    } finally {
      fresh.mockRestore();
    }
  });

  it("reads the first block of the belief's own page (review L5)", async () => {
    const fresh = jest.spyOn(indexer, 'ensureFresh').mockResolvedValue();
    const stray = { profileId: new Types.ObjectId(), blockId: 'blk_stray' };
    try {
      expect((await find('commonword')).total).toBe(1);
      // A row from another page that claims the same tab, edited and first.
      await m.ProfileBlock.collection.insertOne({
        ...stray,
        section: 'beliefs',
        kind: 'paragraph',
        tabId: 'tab_common-holder',
        label: '',
        order: -1,
        currentVersionSeq: 2,
      });
      await m.BlockVersion.collection.insertMany([
        versionRow('blk_stray', 1, 'Stray one.', GENESIS_HASH),
        versionRow('blk_stray', 2, 'Stray two.', GENESIS_HASH),
      ]);
      expect((await find('commonword')).total).toBe(1);
    } finally {
      fresh.mockRestore();
      await m.ProfileBlock.collection.deleteOne({ blockId: 'blk_stray' });
    }
  });
});

describeStandalone('search on a standalone mongod with no text index', () => {
  const production = { get: () => undefined };
  jest.setTimeout(60_000);
  let conn: mongoose.Connection;
  const m = {} as Record<string, Model<any>>;
  let search: SearchService;
  let engines: SearchEngineService;
  let members: MembersService;

  beforeAll(async () => {
    conn = await mongoose.createConnection(String(standaloneUri)).asPromise();
    await conn.dropDatabase();
    for (const { name, schema } of MANAGED_SCHEMAS) {
      m[name] = conn.model(name, schema);
      await m[name].createCollection();
      // Every index but the search fallback's own: a database where
      // db:indexes never ran for this chunk.
      if (name !== 'SearchEntry') await m[name].createIndexes();
    }
    m.WebsitePage = conn.model('WebsitePage', WebsitePageSchema);
    const { s } = seed();
    await m.SocialProfile.collection.insertMany(s.profiles);
    await m.BeliefTab.collection.insertMany(s.tabs);
    await m.ProfileBlock.collection.insertMany(s.blocks);
    await m.BlockVersion.collection.insertMany(s.versions);
    // ORG's donations page with (synthetic) payment accounts (review M2).
    await m.WebsitePage.collection.insertOne({
      pageId: 'donations',
      published: {
        revision: 1,
        content: {
          kind: 'reference',
          id: 'donations',
          title: 'Gifts',
          subtitle: 'Synthetic gifts page',
          blocks: [
            {
              id: 'd1',
              kind: 'paragraph',
              text: 'Give at paypal.me/synthetic-org or $synthorg today.',
            },
          ],
        },
        publishedAt: new Date('2026-11-01T09:00:00.000Z'),
        publishedBy: 'system:test',
      },
      history: [],
    });
    members = new MembersService(
      m.SocialProfile,
      m.BeliefTab,
      m.ProfileBlock,
      m.BlockVersion,
      m.Comment,
      {} as never,
      {} as never,
      fakeAdmin as never,
    );
    engines = new SearchEngineService(m.SearchEntry, {
      get: () => 'create',
    } as never);
    const indexer = new SearchIndexerService(
      m.SearchEntry,
      m.SocialProfile,
      m.BeliefTab,
      m.ProfileBlock,
      m.BlockVersion,
      m.WebsitePage,
      production as never,
    );
    search = new SearchService(
      m.SearchEntry,
      members,
      engines,
      indexer,
      production as never,
    );
    await indexer.refresh({ full: true });
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  it('cannot create an Atlas Search index here and says so, without throwing', async () => {
    await expect(engines.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('answers with the regex, behind the same visibility filter', async () => {
    const missing = jest.spyOn(engines, 'textIndexMissing');
    const guest = await search.search(
      WORD,
      'all',
      1,
      await members.resolveViewer({ headers: {} } as never),
    );
    expect(missing).toHaveBeenCalled();
    // No CMS page in this database: the 14 public beliefs.
    expect(guest.total).toBe(PUBLIC_HITS - 1);
    expect(JSON.stringify(guest)).not.toMatch(/velvet|lattice|cellar|spire/);
    expect(await engines.engines()).toEqual(['regex']);
  });

  const guest = () => members.resolveViewer({ headers: {} } as never);

  it('finds a word whatever its accents, on the regex too (review L1)', async () => {
    for (const q of ['cafe', 'café', 'CAFÉ']) {
      const found = await search.search(q, 'all', 1, await guest());
      expect([q, found.results.map((r: any) => r.slug)]).toEqual([
        q,
        ['cafe-holder'],
      ]);
    }
  });

  it('never shows the test site real payment accounts (review M2)', async () => {
    const testSite = {
      get: (key: string) => (key === 'SITE_ENV' ? 'test' : undefined),
    };
    const testIndexer = new (SearchIndexerService as any)(
      m.SearchEntry,
      m.SocialProfile,
      m.BeliefTab,
      m.ProfileBlock,
      m.BlockVersion,
      m.WebsitePage,
      testSite,
    ) as SearchIndexerService;
    const testSearch = new (SearchService as any)(
      m.SearchEntry,
      members,
      engines,
      testIndexer,
      testSite,
    ) as SearchService;
    const fresh = jest.spyOn(testIndexer, 'ensureFresh').mockResolvedValue();
    // The production copy of the page is in the index: never on the test site.
    expect((await search.search('paypal', 'all', 1, await guest())).total).toBe(
      1,
    );
    for (const q of ['paypal', 'synthorg', 'synthetic org']) {
      expect([
        q,
        (await testSearch.search(q, 'all', 1, await guest())).total,
      ]).toEqual([q, 0]);
    }
    await testIndexer.refresh({ full: true });
    // Each site keeps its own copy: the test site never overwrites
    // production's (review L3).
    expect((await search.search('paypal', 'all', 1, await guest())).total).toBe(
      1,
    );
    for (const q of ['paypal', 'synthorg', 'synthetic org']) {
      expect([
        q,
        (await testSearch.search(q, 'all', 1, await guest())).total,
      ]).toEqual([q, 0]);
    }
    const placeholder = await testSearch.search(
      'give today',
      'all',
      1,
      await guest(),
    );
    expect(placeholder.results[0]?.snippet).toContain(
      '(test site: no real payment)',
    );
    fresh.mockRestore();
  });
});
