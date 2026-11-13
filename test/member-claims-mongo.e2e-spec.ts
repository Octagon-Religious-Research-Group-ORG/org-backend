/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
// Claims against a REAL MongoDB (Chunk 11): the unique indexes and the
// conditional writes that keep "one owner per page, one page per login"
// whatever the timing. Only a real database can say that, so this needs
// MONGO_TEST_URI (a throwaway database; it is dropped). Without it the suite
// is reported as SKIPPED, never as passed. Synthetic data only.
import mongoose, { type Model, Types } from 'mongoose';
import { WebsitePageSchema } from '../src/content/schemas/website-page.schema';
import { MANAGED_SCHEMAS } from '../src/db/managed-schemas';
import {
  ClaimsService,
  NOT_CLAIMABLE,
} from '../src/members/claims/claims.service';
import { LegacyLinksService } from '../src/members/claims/legacy-links.service';
import { CommentWritersService } from '../src/members/comments/comment-writers';
import {
  seedBlocks,
  seedImportedComments,
  seedOrgPages,
  seedProfiles,
  seedTabs,
  U,
} from '../src/members/comments/comments-harness.mocks-spec';
import { MemberPageEditorService } from '../src/members/member-page-editor.service';
import {
  MembersService,
  PROFILE_NOT_FOUND,
} from '../src/members/members.service';
import { OrgPagesService } from '../src/members/org-pages/org-pages.service';
import { OWN_BELIEF, VotersService } from '../src/members/votes/voters.service';
import { VoteTalliesService } from '../src/members/votes/vote-tallies.service';
import { VotesService } from '../src/members/votes/votes.service';
import { ModerationLogService } from '../src/moderation/moderation-log.service';
import { BlockVersionsService } from '../src/social/block-versions.service';
import { VoteHistoryService } from '../src/social/vote-history.service';

const uri = process.env.MONGO_TEST_URI;
const describeWithMongo = uri ? describe : describe.skip;

const request = (userId?: string) =>
  ({
    headers: userId ? { authorization: `Bearer ${userId}` } : {},
    ...(userId ? { auth: { payload: { sub: userId } } } : {}),
  }) as never;

describeWithMongo('claims on a real MongoDB', () => {
  let conn: mongoose.Connection;
  const m = {} as Record<string, Model<any>>;
  let members: MembersService;
  let claims: ClaimsService;
  let links: LegacyLinksService;
  let editor: MemberPageEditorService;
  let votes: VotesService;
  let pageNumber = 0;
  let gatedClaims: ClaimsService;
  let gatedPageWrites: Model<any>;
  let arrive: (() => Promise<void>) | undefined;
  /** Lets `count` callers through together, once all have arrived. */
  const barrier = (count: number) => {
    let arrived = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return async () => {
      arrived += 1;
      if (arrived >= count) release();
      await gate;
    };
  };

  const viewer = async (userId?: string) =>
    members.resolveViewer(request(userId));
  const ask = async (userId: string, slug: string) =>
    claims.request(
      { ...(await viewer(userId)), userId },
      slug,
      'Synthetic: I wrote this page.',
    );
  /** A fresh ownerless imported page. */
  const importedPage = async (extra: Record<string, unknown> = {}) => {
    const slug = `imported-${++pageNumber}`;
    const _id = new Types.ObjectId();
    await m.SocialProfile.collection.insertOne({
      _id,
      slug,
      displayName: `Imported ${pageNumber}`,
      visibility: 'public',
      reviewStatus: 'approved',
      anonymous: false,
      source: 'migrated',
      imageIds: [],
      contacts: [],
      ...extra,
    });
    return { _id, slug };
  };
  const owners = async (profileId: Types.ObjectId) =>
    (await m.SocialProfile.findOne({ _id: profileId }).lean()).ownerUserId;

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
    const clerk = {
      getIdentity: (userId: string) =>
        Promise.resolve({
          email: `${userId}@example.test`,
          emailVerified: !userId.includes('unverified'),
        }),
    };
    const writers = new CommentWritersService(members, clerk as never);
    const log = new ModerationLogService(m.ModerationLogEntry);
    claims = new ClaimsService(
      m.Claim,
      m.SocialProfile,
      members,
      writers,
      clerk as never,
      log,
    );
    links = new LegacyLinksService(m.Claim, m.Comment, m.SocialProfile, log);
    // The same service, except every page write waits at a barrier until
    // `arrive` lets it go: two approvals then bind at the same moment.
    const pages = m.SocialProfile;
    const gatedPages = new Proxy(pages, {
      get(target, prop) {
        if (prop === 'updateOne') {
          return (filter: unknown, update: unknown) => {
            const query = target.updateOne(filter as never, update as never);
            return {
              exec: async () => {
                if (arrive) await arrive();
                return query.exec();
              },
            };
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    gatedClaims = new ClaimsService(
      m.Claim,
      gatedPages,
      members,
      writers,
      clerk as never,
      log,
    );
    gatedPageWrites = gatedPages;
    const orgPages = new OrgPagesService(m.WebsitePage);
    const tallies = new VoteTalliesService(
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
      new VoteHistoryService(m.VoteHistoryEntry),
      { anonymousMayVote: () => Promise.resolve(false) } as never,
      orgPages,
    );
  });

  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it('declares the claims indexes db:indexes creates', async () => {
    const indexes = await m.Claim.collection.indexes();
    const byKey = new Map(indexes.map((i) => [JSON.stringify(i.key), i]));
    expect(byKey.get('{"userId":1}')).toMatchObject({
      unique: true,
      partialFilterExpression: { status: 'pending' },
    });
    expect(byKey.get('{"profileId":1}')).toMatchObject({
      unique: true,
      partialFilterExpression: { status: 'approved' },
    });
    expect(byKey.has('{"status":1,"createdAt":1}')).toBe(true);
    expect(byKey.has('{"userId":1,"createdAt":-1}')).toBe(true);
    expect(byKey.has('{"profileId":1,"status":1}')).toBe(true);
  });

  it('the queue and a claimant’s list read their indexes', async () => {
    const plan = async (query: Promise<any>) => JSON.stringify(await query);
    const queue = await plan(
      m.Claim.find({ status: 'pending' }).sort({ createdAt: 1 }).explain(),
    );
    expect(queue).toContain('status_1_createdAt_1');
    const mine = await plan(
      m.Claim.find({ userId: 'x' }).sort({ createdAt: -1 }).explain(),
    );
    expect(mine).toContain('userId_1_createdAt_-1');
  });

  it('a request, then an approval, binds the page and the owner gets the owner tools', async () => {
    const claimant = 'user_claim_flow';
    expect((await claims.mine(claimant)).mayClaim).toBe(true);
    const asked = await ask(claimant, 'imported-page');
    expect(asked.status).toBe('pending');
    expect(await claims.mine(claimant)).toMatchObject({
      mayClaim: false,
      block: 'has-pending',
    });
    // Others still see "claimable": a waiting request is not revealed.
    expect(
      await members.profile('imported-page', await viewer('user_someone')),
    ).toMatchObject({ claimable: true });

    await expect(claims.approve(U.admin, asked.claimId)).resolves.toEqual({
      approved: true,
    });
    const page = await m.SocialProfile.findOne({
      slug: 'imported-page',
    }).lean();
    expect(page.ownerUserId).toBe(claimant);
    // The page itself is otherwise untouched.
    expect(page).toMatchObject({
      source: 'migrated',
      reviewStatus: 'approved',
    });

    const owner = await viewer(claimant);
    expect(owner.kind).toBe('named-member');
    const view = await members.profile('imported-page', owner);
    expect(view).toMatchObject({ access: 'full', isOwner: true });
    expect(view).toHaveProperty('revisions');
    expect(view).not.toHaveProperty('claimable');

    // Chunk 8: the new owner edits the imported belief.
    const { headSeq } = await editor.readTabText(page._id, 'tab_i');
    await expect(
      editor.editTabText(claimant, 'tab_i', 'Synthetic new wording.', headSeq),
    ).resolves.toMatchObject({ changed: true });
    // Chunk 10: and may not vote on their own beliefs.
    const current = (await editor.readTabText(page._id, 'tab_i')).headSeq;
    await expect(
      votes.cast(owner, {
        slug: 'imported-page',
        tabId: 'tab_i',
        value: 'agree',
        baseSeq: current,
      }),
    ).rejects.toThrow(OWN_BELIEF);

    expect(await claims.mine(claimant)).toMatchObject({
      mayClaim: false,
      block: 'has-page',
      claims: [{ status: 'approved', page: { slug: 'imported-page' } }],
    });
    const logged = await m.ModerationLogEntry.find({
      targetId: asked.claimId,
    })
      .sort({ at: 1 })
      .lean();
    expect(logged.map((e) => e.action)).toEqual([
      'claim.requested',
      'claim.approved',
    ]);
    expect(logged[1].actorUserId).toBe(U.admin);
  });

  it('a page nobody may see, a deleted one and an unknown one answer the same 404', async () => {
    const deleted = await importedPage({ deletedAt: new Date() });
    const hidden = await importedPage({ visibility: 'unlisted' });
    for (const slug of [deleted.slug, hidden.slug, 'no-such-page']) {
      await expect(ask('user_404_probe', slug)).rejects.toThrow(
        PROFILE_NOT_FOUND,
      );
    }
    await expect(ask('user_404_probe', 'open-page')).rejects.toThrow(
      NOT_CLAIMABLE,
    );
    expect(await m.Claim.countDocuments({ userId: 'user_404_probe' })).toBe(0);
  });

  it('two requests from one login at once: exactly one waits', async () => {
    for (let round = 0; round < 10; round++) {
      const [a, b] = [await importedPage(), await importedPage()];
      const who = `user_double_${round}`;
      const results = await Promise.allSettled([
        ask(who, a.slug),
        ask(who, b.slug),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        await m.Claim.countDocuments({ userId: who, status: 'pending' }),
      ).toBe(1);
    }
  });

  it('two approvals of two requests for one page race: one owner, the other rejected', async () => {
    const winners = { first: 0, second: 0 };
    for (let round = 0; round < 15; round++) {
      const target = await importedPage();
      const first = await ask(`user_race_a_${round}`, target.slug);
      const second = await ask(`user_race_b_${round}`, target.slug);
      const results = await Promise.allSettled([
        claims.approve('user_admin_one', first.claimId),
        claims.approve('user_admin_two', second.claimId),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const owner = await owners(target._id);
      expect([`user_race_a_${round}`, `user_race_b_${round}`]).toContain(owner);
      winners[owner === `user_race_a_${round}` ? 'first' : 'second'] += 1;
      const rows = await m.Claim.find({ profileId: target._id }).lean();
      expect(rows.map((r) => r.status).sort()).toEqual([
        'approved',
        'rejected',
      ]);
      expect(rows.find((r) => r.status === 'approved').userId).toBe(owner);
      expect(rows.every((r) => r.approvingAt === undefined)).toBe(true);
    }
    // Which side wins depends on timing; the invariant above must hold either way.
    expect(winners.first + winners.second).toBe(15);
    console.warn(`claims race winners: ${JSON.stringify(winners)}`);
  });

  it('two approvals that bind at the same moment: the database lets one in', async () => {
    try {
      for (let round = 0; round < 10; round++) {
        const target = await importedPage();
        const first = await ask(`user_bind_a_${round}`, target.slug);
        const second = await ask(`user_bind_b_${round}`, target.slug);
        arrive = barrier(2);
        const results = await Promise.allSettled([
          gatedClaims.approve('user_admin_one', first.claimId),
          gatedClaims.approve('user_admin_two', second.claimId),
        ]);
        arrive = undefined;
        const refused = results.filter((r) => r.status === 'rejected');
        expect(refused).toHaveLength(1);
        // The loser reached the bind and found the page taken.
        expect(String(refused[0].reason)).toMatch(
          /now belongs to another member/,
        );
        const rows = await m.Claim.find({ profileId: target._id }).lean();
        expect(rows.map((r) => r.status).sort()).toEqual([
          'approved',
          'rejected',
        ]);
        expect(rows.find((r) => r.status === 'approved').userId).toBe(
          await owners(target._id),
        );
      }
    } finally {
      arrive = undefined;
    }
  });

  it('one login bound to two pages at the same moment: the unique index lets one in', async () => {
    try {
      for (let round = 0; round < 10; round++) {
        const [one, two] = [await importedPage(), await importedPage()];
        const who = `user_two_pages_${round}`;
        const asked = await ask(who, one.slug);
        arrive = barrier(2);
        // A second binding of the same login, as a bug or a second admin
        // path would write it, raced against the approval.
        const results = await Promise.allSettled([
          gatedClaims.approve('user_admin_one', asked.claimId),
          gatedPageWrites
            .updateOne(
              { _id: two._id, ownerUserId: { $exists: false } },
              { $set: { ownerUserId: who } },
            )
            .exec(),
        ]);
        arrive = undefined;
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(await m.SocialProfile.countDocuments({ ownerUserId: who })).toBe(
          1,
        );
      }
    } finally {
      arrive = undefined;
    }
  });

  it('the same request approved twice at once: one approval, one record', async () => {
    for (let round = 0; round < 10; round++) {
      const target = await importedPage();
      const asked = await ask(`user_twice_${round}`, target.slug);
      const results = await Promise.allSettled([
        claims.approve('user_admin_one', asked.claimId),
        claims.approve('user_admin_two', asked.claimId),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await owners(target._id)).toBe(`user_twice_${round}`);
      expect(
        await m.ModerationLogEntry.countDocuments({
          targetId: asked.claimId,
          action: 'claim.approved',
        }),
      ).toBe(1);
    }
  });

  it('an approval racing a rejection: one decision, and a page bound only when approved', async () => {
    for (let round = 0; round < 15; round++) {
      const target = await importedPage();
      const asked = await ask(`user_vs_${round}`, target.slug);
      await Promise.allSettled([
        claims.approve('user_admin_one', asked.claimId),
        claims.reject('user_admin_two', asked.claimId, 'Synthetic reason'),
      ]);
      const row = await m.Claim.findOne({ _id: asked.claimId }).lean();
      const owner = await owners(target._id);
      if (row.status === 'approved') {
        expect(owner).toBe(`user_vs_${round}`);
      } else {
        expect(row.status).toBe('rejected');
        expect(owner).toBeUndefined();
      }
    }
  });

  it('an approval racing a join by the same login leaves that login one page', async () => {
    for (let round = 0; round < 10; round++) {
      const target = await importedPage();
      const who = `user_join_race_${round}`;
      const asked = await ask(who, target.slug);
      // The join's first write (Chunk 6): a placeholder row holding the owner.
      const join = m.SocialProfile.create({
        slug: `joining-${round}`,
        displayName: '(joining)',
        visibility: 'unlisted',
        reviewStatus: 'claiming',
        ownerUserId: who,
        source: 'native',
      });
      await Promise.allSettled([claims.approve(U.admin, asked.claimId), join]);
      expect(await m.SocialProfile.countDocuments({ ownerUserId: who })).toBe(
        1,
      );
      const row = await m.Claim.findOne({ _id: asked.claimId }).lean();
      // A refused approval lets go of its lock, so an admin can decide again.
      expect(row.approvingAt).toBeUndefined();
      expect(['approved', 'pending']).toContain(row.status);
    }
  });

  it('a withdrawn request frees the login to ask again; an unverified email cannot ask', async () => {
    const target = await importedPage();
    const asked = await ask('user_changes_mind', target.slug);
    await claims.withdraw('user_changes_mind', asked.claimId);
    await expect(ask('user_changes_mind', target.slug)).resolves.toMatchObject({
      status: 'pending',
    });
    await expect(ask('user_unverified_claim', target.slug)).rejects.toThrow(
      /confirm your email/,
    );
  });

  it('links and unlinks picked imported comments, keeping text, name and date', async () => {
    const target = await importedPage({
      displayName: 'Synthetic Pages Author',
    });
    const who = 'user_linker';
    const asked = await ask(who, target.slug);
    await expect(links.candidates(asked.claimId)).rejects.toThrow(
      /once the request is approved/,
    );
    await claims.approve(U.admin, asked.claimId);

    const before = await m.Comment.findOne({ commentId: 'cmt_imp4' }).lean();
    const list = await links.candidates(asked.claimId);
    expect(list.comments.find((c) => c.commentId === 'cmt_imp4')).toMatchObject(
      { nameMatches: true, linked: false },
    );

    expect(
      await links.link(U.admin, asked.claimId, ['cmt_imp4', 'no-such']),
    ).toEqual({ linked: ['cmt_imp4'], skipped: ['no-such'] });
    const after = await m.Comment.findOne({ commentId: 'cmt_imp4' }).lean();
    expect(after.linkedUserId).toBe(who);
    for (const field of [
      'body',
      'legacyAuthorName',
      'createdAt',
      'anchorText',
    ]) {
      expect(after[field]).toEqual(before[field]);
    }
    // Linked to one member, it cannot be linked to another.
    expect((await links.candidates(asked.claimId)).comments[0]).toMatchObject({
      commentId: 'cmt_imp4',
      linked: true,
    });
    expect(await links.unlink(U.admin, asked.claimId, ['cmt_imp4'])).toEqual({
      unlinked: ['cmt_imp4'],
      skipped: [],
    });
    expect(
      (await m.Comment.findOne({ commentId: 'cmt_imp4' }).lean()).linkedUserId,
    ).toBeUndefined();
    const actions = (
      await m.ModerationLogEntry.find({ targetId: 'cmt_imp4' })
        .sort({ at: 1 })
        .lean()
    ).map((e) => e.action);
    expect(actions).toEqual([
      'comment.legacy-linked',
      'comment.legacy-unlinked',
    ]);
  });
});
