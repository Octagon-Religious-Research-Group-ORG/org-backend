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
import { SearcherCounter } from '../src/search/searcher-counter';
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
          useValue: {
            get: (key: string, fallback: unknown) =>
              key === 'SEARCH_FRAGMENT_MIN_SEARCHERS' ? 2 : fallback,
          },
        },
        ...[
          'SocialProfile',
          'BeliefTab',
          'ProfileBlock',
          'BlockVersion',
          'Comment',
          'SearchEntry',
          'SearchTermDay',
          'SearchFragmentHide',
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
    await m.SearchTermDay.deleteMany({});
    (fragments as any).counter = new SearcherCounter();
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
    const rows = await m.SearchTermDay.find({}).lean();
    expect(rows.map((row: any) => row.term)).toEqual(['lantern']);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['_id', 'day', 'expiresAt', 'searchers', 'term'].sort(),
    );
    (fragments as any).cache = undefined;
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
    (fragments as any).cache = undefined;
    expect((await get('/search/fragments').expect(200)).body.fragments).toEqual(
      [],
    );
    await m.SocialProfile.updateOne(
      { slug: 'open-seeker' },
      { $set: { visibility: 'public' } },
    );
  });
});

describeStandalone('search on a standalone mongod with no text index', () => {
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
    );
    search = new SearchService(m.SearchEntry, members, engines, indexer);
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
});
