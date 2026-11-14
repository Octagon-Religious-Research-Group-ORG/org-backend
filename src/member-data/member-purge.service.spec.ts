import { Types } from 'mongoose';
import {
  fakeModel,
  type FakeModel,
} from '../test-support/fake-model.mocks-spec';
import { writeGateId } from './schemas/user-write-gate.schema';
import { PURGE_OPTION, PURGED_PERSON } from '../social/purge-rules';
import { purgeAfterOf } from './member-data.constants';
import {
  MemberPurgeService,
  holdsId,
  LOG_SCAN_BATCH,
  PURGE_LEASE_MS,
  PURGED_NAME,
  purgedSlug,
} from './member-purge.service';
import {
  formerActor,
  purgedAccountId,
} from './schemas/account-deletion.schema';
import { PictureStore } from '../members/picture-store.service';
import { PERSON_DETAIL_KEYS } from '../moderation/log-details';
import { redactionKey } from '../anchoring/redaction';
import { PURGE_LOCK_ID } from './schemas/purge-run-lock.schema';

const IMG = new Types.ObjectId().toHexString();

const U = 'user_gone';
const OTHER = 'user_other';
const DELETED = new Date('2026-11-14T12:00:00Z');
const DUE = purgeAfterOf(DELETED);
const RUN = new Date(DUE.getTime() + 60_000);
const H = (c: string) => c.repeat(64);

type Models = Record<string, FakeModel>;

/**
 * U deleted their page P at DELETED. Optionally their Clerk account was
 * deleted at the same time (`account: true`). OTHER's page Q carries a
 * version accepted from U's suggestion.
 */
function scenario({
  account = false,
  page = true,
  picturesHeld = true,
}: { account?: boolean; page?: boolean; picturesHeld?: boolean } = {}) {
  const P = new Types.ObjectId();
  const Q = new Types.ObjectId();
  const ACC = new Types.ObjectId();
  const m: Models = {
    profiles: fakeModel([
      ...(page
        ? [
            {
              _id: P,
              slug: 'quiet-fern',
              displayName: 'Quiet Fern',
              ownerUserId: U,
              contacts: [{ method: 'signal', value: 'synthetic-handle' }],
              imageIds: [IMG],
              similarNameOf: ['other'],
              legacy: {
                pagesUrl: 'https://pages.invalid/x',
                importedAt: DELETED,
              },
              deletedAt: DELETED,
              deletion: {
                at: DELETED,
                source: account ? 'account-deleted' : 'member',
                purgeAfter: DUE,
                undoUntil: new Date(DELETED.getTime() + 1),
              },
            },
          ]
        : []),
      { _id: Q, slug: 'open-page', displayName: 'Open', ownerUserId: OTHER },
    ]),
    tabs: fakeModel([
      {
        profileId: P,
        tabId: 'tab1',
        title: 'Synthetic belief',
        group: 'Synthetic group',
      },
      { profileId: Q, tabId: 'tabq', title: 'Their belief', group: 'Theirs' },
    ]),
    blocks: fakeModel([
      { profileId: P, blockId: 'blk1', label: 'II.' },
      { profileId: Q, blockId: 'blkq', label: 'A.' },
    ]),
    versions: fakeModel([
      {
        blockId: 'blk1',
        seq: 1,
        text: 'Synthetic text one',
        authorUserId: U,
        prevHash: H('0'),
        hash: H('1'),
        createdAt: DELETED,
      },
      {
        blockId: 'ttl_tab1',
        seq: 1,
        text: 'Synthetic title',
        authorUserId: U,
        prevHash: H('0'),
        hash: H('3'),
        createdAt: DELETED,
      },
      // On OTHER's live page, accepted from U's suggestion.
      {
        blockId: 'blkq',
        seq: 2,
        text: 'Accepted wording',
        authorUserId: OTHER,
        suggestionId: 'c-sugg-q',
        suggestedBy: U,
        prevHash: H('8'),
        hash: H('9'),
        createdAt: DELETED,
      },
    ]),
    comments: fakeModel([
      {
        commentId: 'c-mine',
        profileId: Q,
        authorUserId: U,
        body: 'My synthetic comment',
        anchorText: 'quoted on Q',
      },
      {
        commentId: 'c-sugg-q',
        profileId: Q,
        authorUserId: U,
        kind: 'suggestion',
        body: '',
        suggestion: { proposedText: 'Accepted wording' },
      },
      {
        commentId: 'c-linked',
        profileId: Q,
        legacyAuthorName: 'Synthetic Pages Name',
        linkedUserId: U,
        body: 'Imported text',
        anchorText: 'quoted',
      },
      {
        commentId: 'c-on-p',
        profileId: P,
        authorUserId: OTHER,
        body: 'Their comment on my page',
        anchorText: 'Synthetic text one',
        suggestion: {
          proposedText: 'Their rewording of my belief',
          decidedBy: U,
        },
      },
      {
        commentId: 'c-keep',
        profileId: Q,
        authorUserId: OTHER,
        body: 'Unrelated',
        anchorText: 'Unrelated quote',
      },
    ]),
    commentVersions: fakeModel(
      [
        {
          commentId: 'c-mine',
          seq: 1,
          text: 'My synthetic comment',
          authorUserId: U,
          prevHash: H('0'),
          hash: H('a'),
        },
        {
          commentId: 'c-keep',
          seq: 1,
          text: 'Unrelated',
          authorUserId: OTHER,
          prevHash: H('0'),
          hash: H('b'),
        },
      ],
      { unique: [['commentId', 'seq']] },
    ),
    votes: fakeModel(
      [
        { tabId: 'tabq', voterUserId: U, value: 'agree' },
        { tabId: 'tabq', voterUserId: OTHER, value: 'agree' },
      ],
      { unique: [['tabId', 'voterUserId']] },
    ),
    voteHistory: fakeModel([
      { voteKey: `tabq:${U}`, seq: 1, voterUserId: U, hash: H('c') },
      { voteKey: `tabq:${OTHER}`, seq: 1, voterUserId: OTHER, hash: H('f') },
    ]),
    claims: fakeModel([
      { userId: U, message: 'It is my page', status: 'approved' },
      { userId: OTHER, message: 'Theirs', status: 'pending' },
    ]),
    reports: fakeModel([
      { reporterUserId: U, note: 'Synthetic note', reason: 'spam' },
      { reporterUserId: OTHER, note: 'Their note', reason: 'spam' },
    ]),
    log: fakeModel([
      // 0: U acting as a moderator on someone else's comment.
      {
        actorUserId: U,
        action: 'comment.hidden',
        targetType: 'comment',
        targetId: 'c-keep',
        reason: 'Moderator note by U',
        details: { x: 1 },
      },
      // 1: U as moderator again: the same label must come back.
      {
        actorUserId: U,
        action: 'report.dismissed',
        targetType: 'comment',
        targetId: 'c-keep',
        reason: 'Second note',
      },
      // 2: an admin changed U's role.
      {
        actorUserId: 'user_admin',
        action: 'role.changed',
        targetType: 'user',
        targetId: U,
        reason: 'Role note about U',
        details: { from: 'member' },
      },
      // 3: about U's page.
      {
        actorUserId: 'user_admin',
        action: 'page.approved',
        targetType: 'member-page',
        targetId: String(P),
        reason: 'Approved',
        details: { slug: 'quiet-fern', ownerUserId: U },
      },
      // 4: about U's comment.
      {
        actorUserId: 'user_admin',
        action: 'comment.hidden',
        targetType: 'comment',
        targetId: 'c-mine',
        reason: 'Hid it',
        details: { x: 1 },
      },
      // 5: about U's claim.
      {
        actorUserId: 'user_admin',
        action: 'claim.approved',
        targetType: 'claim',
        targetId: 'later',
        reason: 'Claim ok',
        details: { userId: U },
      },
      // 6: unrelated.
      {
        actorUserId: 'user_admin',
        action: 'other',
        targetType: 'member-page',
        targetId: String(Q),
        reason: 'Unrelated',
        details: { ownerUserId: OTHER },
      },
    ]),
    consents: fakeModel([
      { userId: U, ip: '203.0.113.7', termsVersion: '1' },
      { userId: OTHER, ip: '203.0.113.8', termsVersion: '1' },
    ]),
    visits: fakeModel([
      {
        kind: 'guest-entry',
        at: new Date('2026-01-01T00:00:00Z'),
        ip: '198.51.100.1',
      },
      {
        kind: 'guest-entry',
        at: new Date('2031-11-14T00:00:00Z'),
        ip: '198.51.100.2',
      },
    ]),
    contacts: fakeModel([
      { userId: U, backup: [] },
      { userId: OTHER, backup: [] },
    ]),
    prefs: fakeModel([{ userId: U }, { userId: OTHER }]),
    queue: fakeModel([
      { userId: U, status: 'queued' },
      { userId: 'user_r', actorUserId: U, status: 'queued' },
      { userId: OTHER, status: 'queued' },
    ]),
    inbox: fakeModel([
      { subjectUserId: U, note: 'Synthetic EaM note' },
      { subjectUserId: OTHER, note: 'Theirs' },
    ]),
    imports: fakeModel([
      {
        profileId: P,
        slug: 'quiet-fern',
        pagesUrl: 'https://pages.invalid/x',
        extractedText: 'All of it',
        sources: [{ fileName: 'x.docx' }],
        report: { ok: true },
      },
    ]),
    search: fakeModel([{ profileId: P }, { profileId: Q }]),
    lock: fakeModel([], { unique: [['_id']] }),
    gates: fakeModel([
      { _id: writeGateId(U), at: DELETED, n: 3 },
      { _id: writeGateId(OTHER), at: DELETED, n: 1 },
    ]),
    accounts: fakeModel(
      account
        ? [
            {
              _id: ACC,
              userId: U,
              at: DELETED,
              purgeAfter: DUE,
              ...(page ? { profileId: P } : {}),
            },
          ]
        : [],
      { unique: [['userId']] },
    ),
  };
  m.log.docs[5].targetId = String(m.claims.docs[0]._id);
  if (!page) {
    // An account that never had a page: no page rows at all.
    for (const model of [m.tabs, m.blocks, m.versions, m.imports, m.search]) {
      model.docs.splice(
        0,
        model.docs.length,
        ...model.docs.filter(
          (row) =>
            String(row.profileId) !== String(P) &&
            row.blockId !== 'blk1' &&
            row.blockId !== 'ttl_tab1',
        ),
      );
    }
    m.comments.docs.splice(3, 1);
  }
  // The real store over a stand-in bucket that answers like the GridFS
  // driver: deleting a file it does not hold throws "File not found".
  const files = new Set(picturesHeld === false ? [] : [IMG]);
  const pictures = new PictureStore({} as never);
  (pictures as unknown as { bucket: () => unknown }).bucket = () => ({
    delete: (id: unknown) => {
      if (!files.delete(String(id))) {
        return Promise.reject(new Error(`File not found for id ${String(id)}`));
      }
      return Promise.resolve();
    },
  });
  const record = jest.fn(() => Promise.resolve({}));
  const service = new MemberPurgeService(
    m.profiles as never,
    m.tabs as never,
    m.blocks as never,
    m.versions as never,
    m.comments as never,
    m.commentVersions as never,
    m.votes as never,
    m.voteHistory as never,
    m.claims as never,
    m.reports as never,
    m.log as never,
    m.consents as never,
    m.visits as never,
    m.contacts as never,
    m.prefs as never,
    m.queue as never,
    m.inbox as never,
    m.imports as never,
    m.search as never,
    m.lock as never,
    m.accounts as never,
    pictures,
    { record } as never,
    m.gates as never,
  );
  const serverClock = service.lockClock;
  service.lockClock = () => RUN;
  return { service, m, P, Q, ACC, files, record, serverClock };
}

/** What a live account's data looks like, to compare before and after. */
function personRows(m: Models) {
  return JSON.stringify([
    m.comments.docs.filter(
      (c) => c.profileId !== undefined && c.commentId !== 'c-on-p',
    ),
    m.commentVersions.docs,
    m.votes.docs,
    m.voteHistory.docs,
    m.claims.docs,
    m.reports.docs,
    m.consents.docs,
    m.contacts.docs,
    m.prefs.docs,
    m.queue.docs,
    m.inbox.docs,
    m.log.docs.filter((e) => e.targetType !== 'member-page'),
    m.versions.docs.filter((v) => v.blockId === 'blkq'),
  ]);
}

describe('MemberPurgeService: "Delete my page" only (the account is live)', () => {
  it('purges the page and its own content, and keeps every hash', async () => {
    const { service, m, P, files, record } = scenario();
    const report = await service.run(RUN);
    expect(report).toMatchObject({
      state: 'ran',
      purged: [String(P)],
      accounts: [],
      failed: [],
      visitAddressesRemoved: 1,
    });
    const own = m.versions.docs.filter((v) => v.blockId !== 'blkq');
    for (const version of own) {
      expect(version).toMatchObject({
        text: '',
        authorUserId: PURGED_PERSON,
        purgedAt: RUN,
      });
    }
    expect(own.map((v) => [v.seq, v.prevHash, v.hash])).toEqual([
      [1, H('0'), H('1')],
      [1, H('0'), H('3')],
    ]);
    expect(m.profiles.docs[0]).toMatchObject({
      slug: purgedSlug(P),
      displayName: PURGED_NAME,
      contacts: [],
      imageIds: [],
      deletion: { purgeStartedAt: RUN, purgedAt: RUN },
    });
    for (const gone of ['ownerUserId', 'legacy']) {
      expect(m.profiles.docs[0]).not.toHaveProperty(gone);
    }
    expect(files.size).toBe(0);
    // Review #8: tab title and group, block label.
    expect(m.tabs.docs[0].title).toBe('');
    expect(m.tabs.docs[0]).not.toHaveProperty('group');
    expect(m.blocks.docs[0].label).toBe('');
    // Other people's text about the page: no quote, no rewording.
    expect(m.comments.docs[3].body).toBe('Their comment on my page');
    expect(m.comments.docs[3]).not.toHaveProperty('anchorText');
    expect(m.comments.docs[3].suggestion).not.toHaveProperty('proposedText');
    expect(m.imports.docs[0]).toMatchObject({
      slug: purgedSlug(P),
      extractedText: '',
    });
    expect(m.search.docs).toHaveLength(1);
    expect(m.log.docs[3]).not.toHaveProperty('details');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'page.purged' }),
    );
  });

  it('touches nothing of the live account outside the page (review #5)', async () => {
    const { service, m } = scenario();
    const before = personRows(m);
    await service.run(RUN);
    expect(personRows(m)).toBe(before);
    // Their own vote keeps its (tab, voter) slot: they cannot vote twice.
    expect(m.votes.docs[0].voterUserId).toBe(U);
    await expect(
      Promise.resolve().then(() =>
        m.votes.create({ tabId: 'tabq', voterUserId: U, value: 'disagree' }),
      ),
    ).rejects.toMatchObject({ code: 11000 });
    // An admin who deleted their own page keeps their moderator record.
    expect(m.log.docs[0]).toMatchObject({
      actorUserId: U,
      reason: 'Moderator note by U',
    });
  });

  it('touches nothing of a page still inside its five years', async () => {
    const { service, m } = scenario();
    m.profiles.docs[0].deletion = {
      ...(m.profiles.docs[0].deletion as object),
      purgeAfter: new Date(RUN.getTime() + 1),
    };
    const before = JSON.stringify(m.versions.docs);
    await expect(service.run(RUN)).resolves.toMatchObject({
      purged: [],
      accounts: [],
    });
    expect(JSON.stringify(m.versions.docs)).toBe(before);
    await expect(
      service.purgePage(m.profiles.docs[0] as never, RUN),
    ).rejects.toThrow('five-year window');
    await expect(
      service.purgePage(
        { ...m.profiles.docs[0], deletedAt: undefined } as never,
        RUN,
      ),
    ).rejects.toThrow('five-year window');
  });

  it('purges a page with no blocks and no pictures', async () => {
    const { service, m, P } = scenario();
    delete m.profiles.docs[0].imageIds;
    m.blocks.docs.splice(0, 1);
    m.tabs.docs.splice(0, 1);
    await expect(service.run(RUN)).resolves.toMatchObject({
      purged: [String(P)],
    });
  });

  it('reports a page that changed mid-purge, and finishes it on the next run', async () => {
    const { service, m, P } = scenario();
    const original = m.profiles.updateOne;
    let calls = 0;
    m.profiles.updateOne = (...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls === 2) {
        return {
          exec: () => Promise.resolve({ matchedCount: 0, modifiedCount: 0 }),
        };
      }
      return original(...args);
    };
    await expect(service.run(RUN)).resolves.toMatchObject({
      failed: [String(P)],
    });
    expect(m.lock.docs[0]).not.toHaveProperty('lastDay');
    m.profiles.updateOne = original;
    await expect(service.run(RUN)).resolves.toMatchObject({
      purged: [String(P)],
    });
  });
});

describe('MemberPurgeService: a deleted account (person-wide, review #5 and #6)', () => {
  it('purges the person everywhere, five years after the account deletion', async () => {
    const { service, m, P, ACC } = scenario({ account: true });
    const report = await service.run(RUN);
    expect(report).toMatchObject({
      purged: [String(P)],
      accounts: [String(ACC)],
      failed: [],
    });
    const label = formerActor(ACC);

    expect(m.comments.docs[0]).toMatchObject({
      body: '',
      authorUserId: PURGED_PERSON,
      purgedAt: RUN,
    });
    expect(m.comments.docs[0]).not.toHaveProperty('anchorText');
    expect(m.comments.docs[1].suggestion).not.toHaveProperty('proposedText');
    expect(m.comments.docs[2]).toMatchObject({
      body: '',
      legacyAuthorName: PURGED_NAME,
      purgedAt: RUN,
    });
    expect(m.comments.docs[2]).not.toHaveProperty('linkedUserId');
    expect(m.comments.docs[3].suggestion).toMatchObject({
      decidedBy: PURGED_PERSON,
    });
    expect(m.commentVersions.docs[0]).toMatchObject({
      text: '',
      authorUserId: PURGED_PERSON,
      hash: H('a'),
    });

    // Review #4: their id leaves OTHER's version; text and author stay.
    expect(m.versions.docs[2]).toMatchObject({
      text: 'Accepted wording',
      authorUserId: OTHER,
      suggestionId: 'c-sugg-q',
      purgedAt: RUN,
    });
    expect(m.versions.docs[2]).not.toHaveProperty('suggestedBy');

    // Votes stay counted under ids that name no one; the slot stays taken.
    expect(m.votes.docs[0].voterUserId).toBe(
      `${PURGED_PERSON}:${String(m.votes.docs[0]._id)}`,
    );
    expect(m.voteHistory.docs[0]).toMatchObject({
      voterUserId: PURGED_PERSON,
      hash: H('c'),
    });
    expect(m.voteHistory.docs[0].voteKey).toMatch(/^purged:/);

    // Moderator actions: one stable label, reasons kept.
    expect(m.log.docs[0]).toMatchObject({
      actorUserId: label,
      reason: 'Moderator note by U',
      details: { x: 1 },
    });
    expect(m.log.docs[1]).toMatchObject({
      actorUserId: label,
      reason: 'Second note',
    });
    // Entries about them: no id, no details, no free-text reason.
    expect(m.log.docs[2]).toMatchObject({ targetId: label, reason: '' });
    for (const entry of m.log.docs.slice(2, 6)) {
      expect(entry).not.toHaveProperty('details');
      expect(entry.reason).toBe('');
    }
    expect(m.log.docs[6]).toMatchObject({
      reason: 'Unrelated',
      details: { ownerUserId: OTHER },
    });
    expect(JSON.stringify(m.log.docs)).not.toContain(U);

    expect(m.claims.docs[0]).toMatchObject({
      userId: PURGED_PERSON,
      message: '',
    });
    expect(m.reports.docs[0].reporterUserId).toBe(PURGED_PERSON);
    expect(m.consents.docs[0]).toMatchObject({ userId: PURGED_PERSON });
    expect(m.consents.docs[0]).not.toHaveProperty('ip');
    expect(m.inbox.docs[0].subjectUserId).toBe(PURGED_PERSON);
    expect(m.contacts.docs.map((c) => c.userId)).toEqual([OTHER]);
    expect(m.prefs.docs.map((c) => c.userId)).toEqual([OTHER]);
    expect(m.queue.docs.map((q) => q.userId)).toEqual([OTHER]);
    expect(m.accounts.docs[0]).toMatchObject({
      userId: purgedAccountId(ACC),
      purgedAt: RUN,
      purgeStartedAt: RUN,
    });
    expect(m.accounts.docs[0]).not.toHaveProperty('profileId');

    // Nothing anywhere still holds the id.
    expect(JSON.stringify(m)).not.toContain(U);
  });

  it('purges an account that never had a page (review #6)', async () => {
    const { service, m, ACC } = scenario({ account: true, page: false });
    await expect(service.run(RUN)).resolves.toMatchObject({
      purged: [],
      accounts: [String(ACC)],
    });
    expect(JSON.stringify(m)).not.toContain(U);
  });

  it('finishes on the next run after dying past the parent rows (review #1)', async () => {
    const { service, m, ACC } = scenario({ account: true, page: false });
    const original = m.claims.updateMany;
    m.claims.updateMany = () => {
      throw new Error('died after the comments were rewritten');
    };
    await expect(service.run(RUN)).resolves.toMatchObject({
      failed: [String(ACC)],
    });
    // The parents are rewritten already: no comment names U any more.
    expect(m.comments.docs[0].authorUserId).toBe(PURGED_PERSON);
    m.claims.updateMany = original;
    await expect(service.run(RUN)).resolves.toMatchObject({
      accounts: [String(ACC)],
    });
    expect(m.commentVersions.docs[0]).toMatchObject({
      text: '',
      authorUserId: PURGED_PERSON,
    });
    for (const entry of m.log.docs.slice(2, 6)) {
      expect(entry).not.toHaveProperty('details');
    }
    expect(JSON.stringify(m)).not.toContain(U);
  });

  it('refuses an account inside its window, and a record that moved', async () => {
    const { service, m } = scenario({ account: true, page: false });
    await expect(
      service.purgeAccount(
        {
          ...(m.accounts.docs[0] as Record<string, unknown>),
          purgeAfter: new Date(RUN.getTime() + 1),
        } as never,
        RUN,
      ),
    ).rejects.toThrow('five-year window');
    const original = m.accounts.updateOne;
    m.accounts.updateOne = (...args: Parameters<typeof original>) => {
      // The last write, which marks the account purged.
      if ((args[1] as { $set?: { purgedAt?: unknown } }).$set?.purgedAt) {
        return {
          exec: () => Promise.resolve({ matchedCount: 0, modifiedCount: 0 }),
        };
      }
      return original(...args);
    };
    await expect(
      service.purgeAccount(m.accounts.docs[0] as never, RUN),
    ).rejects.toThrow('changed');
  });

  it('finds its redaction already written on a rerun', async () => {
    const { service, m, ACC } = scenario({ account: true, page: false });
    const original = m.versions.updateMany;
    let failed = false;
    m.versions.updateMany = (...args: Parameters<typeof original>) => {
      if (!failed && (args[0] as { suggestedBy?: unknown }).suggestedBy) {
        failed = true;
        throw new Error('died after the record');
      }
      return original(...args);
    };
    await expect(service.run(RUN)).resolves.toMatchObject({
      failed: [String(ACC)],
    });
    await expect(service.run(RUN)).resolves.toMatchObject({
      accounts: [String(ACC)],
    });
    expect(
      m.commentVersions.docs.filter((v) =>
        String(v.commentId).startsWith('redaction:'),
      ),
    ).toHaveLength(1);
  });

  it('purges an account with no comments, claims or page', async () => {
    const { service, m, ACC } = scenario({ account: true, page: false });
    m.comments.docs.splice(0);
    m.claims.docs.splice(0);
    await expect(service.run(RUN)).resolves.toMatchObject({
      accounts: [String(ACC)],
    });
  });

  it('passes on a redaction write that fails for any other reason', async () => {
    const { service, m, ACC } = scenario({ account: true, page: false });
    m.commentVersions.create = () => Promise.reject(new Error('disk full'));
    await expect(service.run(RUN)).resolves.toMatchObject({
      failed: [String(ACC)],
    });
    // The suggester id stays until its record can be written.
    expect(m.versions.docs.find((v) => v.blockId === 'blkq')!.suggestedBy).toBe(
      U,
    );
  });

  it('writes every append-only change through the named purge option only', async () => {
    const { service, m } = scenario({ account: true });
    const calls: unknown[][] = [];
    for (const model of [
      m.versions,
      m.commentVersions,
      m.voteHistory,
      m.log,
      m.consents,
      m.visits,
      m.imports,
    ]) {
      const original = model.updateMany;
      model.updateMany = (...args: Parameters<typeof original>) => {
        calls.push(args);
        return original(...args);
      };
    }
    await service.run(RUN);
    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const call of calls) {
      expect(call[2]).toEqual({
        [PURGE_OPTION]: true,
        overwriteImmutable: true,
      });
    }
  });
});

describe('MemberPurgeService: round 2 fixes', () => {
  it('purges a page whose version already lost a purged suggester (#2)', async () => {
    const { service, m, Q, ACC } = scenario({ account: true, page: false });
    // OTHER's page Q is deleted too, due a day after the account.
    Object.assign(m.profiles.docs[0], {
      deletedAt: DELETED,
      deletion: {
        at: DELETED,
        source: 'member',
        purgeAfter: new Date(DUE.getTime() + 86_400_000),
      },
    });
    await expect(service.run(RUN)).resolves.toMatchObject({
      accounts: [String(ACC)],
      purged: [],
    });
    expect(m.versions.docs.find((v) => v.blockId === 'blkq')).toMatchObject({
      text: 'Accepted wording',
      purgedAt: RUN,
    });
    const later = new Date(RUN.getTime() + 2 * 86_400_000);
    service.lockClock = () => later;
    await expect(service.run(later)).resolves.toMatchObject({
      purged: [String(Q)],
    });
    expect(m.versions.docs.find((v) => v.blockId === 'blkq')).toMatchObject({
      text: '',
      authorUserId: PURGED_PERSON,
    });
  });

  it('records the redaction before removing the suggester id (#1)', async () => {
    const { service, m, ACC } = scenario({ account: true, page: false });
    await expect(service.run(RUN)).resolves.toMatchObject({
      accounts: [String(ACC)],
    });
    const version = m.versions.docs.find((v) => v.blockId === 'blkq')!;
    const record = m.commentVersions.docs.find(
      (v) => v.commentId === redactionKey(version._id as Types.ObjectId),
    );
    expect(record).toMatchObject({ seq: 1, authorUserId: 'system:purge' });
    expect(JSON.parse(record!.text as string)).toMatchObject({
      originalHash: H('9'),
      removed: ['suggestedBy'],
    });
  });

  it('finishes after dying past the picture removal, and a picture already gone never blocks (#3)', async () => {
    const { service, m, P, files } = scenario();
    const original = m.profiles.updateOne;
    let calls = 0;
    m.profiles.updateOne = (...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls === 2)
        return {
          exec: () => Promise.resolve({ matchedCount: 0, modifiedCount: 0 }),
        };
      return original(...args);
    };
    await expect(service.run(RUN)).resolves.toMatchObject({
      failed: [String(P)],
    });
    expect(files.size).toBe(0);
    m.profiles.updateOne = original;
    await expect(service.run(RUN)).resolves.toMatchObject({
      purged: [String(P)],
      failed: [],
    });
    const missing = scenario({ picturesHeld: false });
    await expect(missing.service.run(RUN)).resolves.toMatchObject({
      purged: [String(missing.P)],
      failed: [],
    });
  });

  it('writes the completion entry once, even across a rerun (#9a)', async () => {
    const { service, m, P } = scenario();
    const original = m.profiles.updateOne;
    let calls = 0;
    m.profiles.updateOne = (...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls === 2)
        return {
          exec: () => Promise.resolve({ matchedCount: 0, modifiedCount: 0 }),
        };
      return original(...args);
    };
    const record = jest.fn((entry: Record<string, unknown>) =>
      m.log.create({ ...entry, at: RUN }),
    );
    (service as unknown as { log: { record: unknown } }).log = { record };
    await service.run(RUN);
    m.profiles.updateOne = original;
    await expect(service.run(RUN)).resolves.toMatchObject({
      purged: [String(P)],
    });
    expect(m.log.docs.filter((e) => e.action === 'page.purged')).toHaveLength(
      1,
    );
  });

  it('clears free-text reasons about the page, not the purge’s own (#9b)', async () => {
    const { service, m } = scenario();
    await service.run(RUN);
    expect(m.log.docs[3]).toMatchObject({ reason: '' });
    expect(m.log.docs[3]).not.toHaveProperty('details');
  });

  it('clears an entry naming the person with no reason left (#9c)', async () => {
    const { service, m } = scenario({ account: true, page: false });
    m.log.docs.push({
      actorUserId: 'user_admin',
      action: 'x',
      targetType: 'y',
      targetId: 'z',
      reason: '',
      details: { userId: U },
    });
    await service.run(RUN);
    expect(m.log.docs.at(-1)).not.toHaveProperty('details');
  });

  it('purges a page an admin restored after the account was deleted (#6)', async () => {
    const { service, m, P } = scenario({ account: true });
    // Restored by an admin: live again, still owned by the gone account.
    delete m.profiles.docs[0].deletedAt;
    delete m.profiles.docs[0].deletion;
    await service.run(RUN);
    expect(m.profiles.docs[0]).toMatchObject({
      slug: purgedSlug(P),
      deletion: { source: 'account-deleted', purgedAt: RUN },
    });
    expect(JSON.stringify(m)).not.toContain(U);
  });
});

describe('MemberPurgeService: round 3 fixes', () => {
  it('purges the person from every registered person key in the log (M-1)', async () => {
    const { service, m } = scenario({ account: true, page: false });
    for (const key of PERSON_DETAIL_KEYS) {
      m.log.docs.push({
        actorUserId: 'user_admin',
        action: 'x',
        targetType: 'y',
        targetId: 'z',
        reason: '',
        details: { [key]: U },
      });
    }
    await service.run(RUN);
    expect(JSON.stringify(m.log.docs)).not.toContain(U);
  });

  it('never waits for an owned page with a later clock (L-2)', async () => {
    const { service, m, P, ACC } = scenario({ account: true });
    (m.profiles.docs[0].deletion as Record<string, unknown>).purgeAfter =
      new Date(RUN.getTime() + 400 * 86_400_000);
    await expect(service.run(RUN)).resolves.toMatchObject({
      purged: [],
      accounts: [String(ACC)],
    });
    expect(m.profiles.docs[0]).toMatchObject({
      slug: purgedSlug(P),
      deletion: { purgeAfter: RUN },
    });
    expect(JSON.stringify(m)).not.toContain(U);
  });

  it('keeps the purge’s own reason on an account purge (L-3)', async () => {
    const { service, m } = scenario({ account: true });
    const record = jest.fn((entry: Record<string, unknown>) =>
      m.log.create({ ...entry, at: RUN }),
    );
    (service as unknown as { log: { record: unknown } }).log = { record };
    await service.run(RUN);
    expect(
      m.log.docs.find((e) => e.action === 'page.purged')!.reason,
    ).toContain('Five years');
  });
});

describe('MemberPurgeService: the daily run, its lock and the dry run', () => {
  it('runs once per UTC day unless forced, and logs only when something went', async () => {
    const { service, record } = scenario();
    await service.run(RUN);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'purge.ran' }),
    );
    await expect(service.run(RUN)).resolves.toEqual({
      state: 'already-ran',
      day: RUN.toISOString().slice(0, 10),
    });
    record.mockClear();
    await expect(service.run(RUN, true)).resolves.toMatchObject({
      state: 'ran',
      purged: [],
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('is busy while another run holds the lock, and takes over a dead one', async () => {
    const { service, m } = scenario();
    m.lock.docs.push({
      _id: PURGE_LOCK_ID,
      holder: 'other',
      until: new Date(RUN.getTime() + 1),
    });
    await expect(service.run(RUN)).resolves.toEqual({ state: 'busy' });
    service.lockClock = () => new Date(RUN.getTime() + 2);
    await expect(service.run(RUN)).resolves.toMatchObject({ state: 'ran' });
    expect(PURGE_LEASE_MS).toBe(600_000);
  });

  it('stops before its next item when it lost the lock', async () => {
    const { service, m } = scenario();
    const original = m.lock.updateOne;
    let calls = 0;
    m.lock.updateOne = (...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls === 2)
        return {
          exec: () => Promise.resolve({ matchedCount: 0, modifiedCount: 0 }),
        };
      return original(...args);
    };
    const error = jest.spyOn(service['logger'], 'error').mockImplementation();
    await expect(service.run(RUN)).resolves.toMatchObject({
      interrupted: true,
      purged: [],
    });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('lost its lock'),
    );
  });

  it('answers busy when its own lock row cannot be read back, and passes on other lock errors', async () => {
    const { service, m } = scenario();
    const findOne = m.lock.findOne;
    m.lock.findOne = (() => ({
      lean: () => ({ exec: () => Promise.resolve(null) }),
    })) as never;
    await expect(service.run(RUN)).resolves.toEqual({ state: 'busy' });
    m.lock.findOne = findOne;
    m.lock.updateOne = () => ({
      exec: () => Promise.reject(new Error('lock down')),
    });
    await expect(service.run(RUN)).rejects.toThrow('lock down');
  });

  it('never throws from releasing the lock', async () => {
    const { service, m } = scenario();
    const original = m.lock.updateOne;
    const failures: unknown[] = [new Error('x'), 'plain'];
    m.lock.updateOne = (...args: Parameters<typeof original>) => {
      if ((args[1] as { $unset?: unknown }).$unset) {
        const failure = failures.shift();
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error on purpose
        return { exec: () => Promise.reject(failure) };
      }
      return original(...args);
    };
    const error = jest.spyOn(service['logger'], 'error').mockImplementation();
    await expect(service.run(RUN)).resolves.toMatchObject({ state: 'ran' });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('releasing it failed (x)'),
    );
    service.lockClock = () => new Date(RUN.getTime() + PURGE_LEASE_MS + 1);
    await service.run(RUN);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('releasing it failed (plain)'),
    );
  });

  it('logs a failure that is not an Error', async () => {
    const { service, m } = scenario();
    m.tabs.find = () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error on purpose
      throw 'plain';
    };
    await expect(service.run(RUN)).resolves.toMatchObject({
      failed: [expect.any(String)],
    });
  });

  it('lists pages and accounts due, and visitor addresses, changing nothing', async () => {
    const { service, m } = scenario({ account: true });
    const before = JSON.stringify(m);
    expect(await service.due(RUN)).toEqual({
      pages: [
        {
          slug: 'quiet-fern',
          displayName: 'Quiet Fern',
          source: 'account-deleted',
          deletedAt: DELETED.toISOString(),
          purgeAfter: DUE.toISOString(),
        },
      ],
      accounts: [
        {
          deletedAt: DELETED.toISOString(),
          purgeAfter: DUE.toISOString(),
          hadPage: true,
        },
      ],
      hasMore: false,
      visitAddresses: 1,
      retentionYears: 5,
    });
    expect(JSON.stringify(m)).toBe(before);
    expect(await service.due(new Date(DUE.getTime() - 1))).toMatchObject({
      pages: [],
      accounts: [],
    });
    expect(await service.due(RUN, 0)).toMatchObject({ hasMore: true });
    const noPage = scenario({ account: true, page: false });
    expect((await noPage.service.due(RUN)).accounts[0].hadPage).toBe(false);
  });

  it('uses the current time when none is given', async () => {
    const { service, serverClock } = scenario();
    service.lockClock = serverClock;
    await expect(service.run()).resolves.toMatchObject({ state: 'ran' });
    await expect(service.due()).resolves.toMatchObject({ retentionYears: 5 });
  });
});

describe('MemberPurgeService: round 4 fixes', () => {
  it('adds each run’s clock to the account before anything else (#1)', async () => {
    const { service, m } = scenario({ account: true, page: false });
    const original = m.accounts.updateOne;
    m.accounts.updateOne = () => {
      throw new Error('died at the first write');
    };
    const before = JSON.stringify(m);
    await expect(
      service.purgeAccount(m.accounts.docs[0] as never, RUN),
    ).rejects.toThrow('first write');
    expect(JSON.stringify(m)).toBe(before);
    m.accounts.updateOne = original;
    await service.purgeAccount(m.accounts.docs[0] as never, RUN);
    expect(m.accounts.docs[0]).toMatchObject({
      purgeRuns: [RUN],
      purgeStartedAt: RUN,
    });
  });

  it('keeps a record written by a first run provable after a rerun days later (#1)', async () => {
    const { service, m, ACC } = scenario({ account: true, page: false });
    const original = m.claims.updateMany;
    m.claims.updateMany = () => {
      throw new Error('died after the redaction');
    };
    await expect(service.run(RUN)).resolves.toMatchObject({
      failed: [String(ACC)],
    });
    m.claims.updateMany = original;
    const later = new Date(RUN.getTime() + 3 * 86_400_000);
    await expect(service.run(later)).resolves.toMatchObject({
      accounts: [String(ACC)],
    });
    const account = m.accounts.docs[0] as { purgeRuns: Date[] };
    expect(account.purgeRuns).toEqual([RUN, later]);
    const record = m.commentVersions.docs.find((v) =>
      String(v.commentId).startsWith('redaction:'),
    )!;
    expect(record.createdAt).toEqual(RUN);
    expect(
      account.purgeRuns.some(
        (run) => run.getTime() === (record.createdAt as Date).getTime(),
      ),
    ).toBe(true);
  });

  it('names the suggester’s account row in each redaction (#2)', async () => {
    const { service, m, ACC } = scenario({ account: true, page: false });
    await service.run(RUN);
    const record = m.commentVersions.docs.find((v) =>
      String(v.commentId).startsWith('redaction:'),
    )!;
    expect(JSON.parse(record.text as string)).toMatchObject({
      accountId: String(ACC),
    });
  });

  it('clears the id from a log details key nobody registered, by value (#5)', async () => {
    const { service, m } = scenario({ account: true, page: false });
    const error = jest
      .spyOn(
        (service as unknown as { logger: { error: () => void } }).logger,
        'error',
      )
      .mockImplementation(() => undefined);
    m.log.docs.push(
      {
        actorUserId: 'user_admin',
        action: 'x',
        targetType: 'y',
        _id: new Types.ObjectId(),
        targetId: 'z1',
        reason: 'About U',
        details: { unlistedKey: U, kept: 'other' },
      },
      {
        actorUserId: 'user_admin',
        action: 'x',
        targetType: 'y',
        _id: new Types.ObjectId(),
        targetId: 'z2',
        reason: 'A list',
        details: { slug: [OTHER, U] },
      },
      {
        actorUserId: 'user_admin',
        action: 'x',
        targetType: 'y',
        _id: new Types.ObjectId(),
        targetId: 'z3',
        reason: 'Not about U',
        details: { unlistedKey: OTHER },
      },
    );
    await service.run(RUN);
    expect(JSON.stringify(m.log.docs)).not.toContain(U);
    const untouched = m.log.docs.find((e) => e.targetId === 'z3')!;
    expect(untouched).toMatchObject({
      reason: 'Not about U',
      details: { unlistedKey: OTHER },
    });
    const messages = error.mock.calls.map((call) =>
      String((call as unknown[])[0]),
    );
    expect(messages.some((text) => text.includes('unlistedKey'))).toBe(true);
    expect(messages.some((text) => text.includes('"slug"'))).toBe(true);
    expect(messages.join(' ')).not.toContain(U);
    error.mockRestore();
  });
});

describe('MemberPurgeService: round 5 log fixes', () => {
  const entry = (details: Record<string, unknown>, reason = 'Kept reason') => ({
    _id: new Types.ObjectId(),
    actorUserId: 'user_admin',
    action: 'x',
    targetType: 'y',
    targetId: 'z',
    reason,
    details,
  });

  it('finds the id nested two levels deep and inside a longer string (LOW-2)', async () => {
    const { service, m } = scenario({ account: true, page: false });
    const nested = entry({ meta: { people: [U] }, kept: 'other' });
    const inString = entry({ note: `moved by ${U} today` });
    const oneLevel = entry({ list: [OTHER, U] });
    const tooDeep = entry({ a: { b: { c: 'not-the-id' } } });
    m.log.docs.push(nested, inString, oneLevel, tooDeep);
    await service.run(RUN);
    expect(JSON.stringify(m.log.docs)).not.toContain(U);
    const find = (id: unknown) =>
      m.log.docs.find((e) => String(e._id) === String(id))!;
    expect(find(nested._id)).toMatchObject({
      reason: 'Kept reason',
      details: { kept: 'other' },
    });
    expect(find(tooDeep._id)).toMatchObject({
      details: { a: { b: { c: 'not-the-id' } } },
    });
  });

  it('keeps someone else’s entry that names the person only as removedBy (LOW-4)', async () => {
    const { service, m } = scenario({ account: true, page: false });
    const restore = entry(
      {
        restoredTo: 'approved',
        removedBy: U,
        removedAt: '2026-01-01T00:00:00.000Z',
      },
      'Restored after review',
    );
    m.log.docs.push(restore);
    await service.run(RUN);
    const after = m.log.docs.find((e) => String(e._id) === String(restore._id));
    expect(after).toMatchObject({
      reason: 'Restored after review',
      details: {
        restoredTo: 'approved',
        removedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(after!.details).not.toHaveProperty('removedBy');
  });

  it('reads the log in batches', async () => {
    const { service, m } = scenario({ account: true, page: false });
    const many = Array.from({ length: LOG_SCAN_BATCH + 1 }, () =>
      entry({ removedBy: U }),
    );
    m.log.docs.push(...many);
    await service.run(RUN);
    expect(JSON.stringify(m.log.docs)).not.toContain(U);
  });

  it('holdsId stops two levels below the key', () => {
    expect(holdsId({ a: [U] }, U, 0)).toBe(true);
    expect(holdsId({ a: { b: [U] } }, U, 0)).toBe(false);
    expect(holdsId(42, U, 0)).toBe(false);
    expect(holdsId(null, U, 0)).toBe(false);
  });
});

describe('MemberPurgeService: round 6, 7', () => {
  it('treats an entry naming the person as author as about them', async () => {
    const { service, m } = scenario({ account: true, page: false });
    const id = new Types.ObjectId();
    m.log.docs.push({
      _id: id,
      actorUserId: 'user_admin',
      action: 'comment.hidden',
      targetType: 'comment',
      targetId: 'c-elsewhere',
      reason: 'Hid their comment',
      details: { authorUserId: U, tabId: 'tab9' },
    });
    await service.run(RUN);
    const after = m.log.docs.find((e) => String(e._id) === String(id))!;
    expect(after.reason).toBe('');
    expect(after).not.toHaveProperty('details');
  });
});

describe('MemberPurgeService: round 6, 4', () => {
  it('finishes an accept whose marking failed before it redacts', async () => {
    const { service, m } = scenario({ account: true, page: false });
    const sugg = m.comments.docs.find((c) => c.commentId === 'c-sugg-q')!;
    sugg.suggestion = { status: 'accepting', lockId: 'l1' };
    await service.run(RUN);
    expect(sugg.suggestion).toMatchObject({
      status: 'accepted',
      resultSeq: 2,
      resultBlockId: 'blkq',
    });
  });
});

describe('MemberPurgeService: round 7, 6', () => {
  it('marks no comment for a version that names no suggestion', async () => {
    const { service, m } = scenario({ account: true, page: false });
    m.versions.docs.push({
      blockId: 'blkq',
      seq: 3,
      text: 'Older accepted wording',
      authorUserId: OTHER,
      suggestedBy: U,
      prevHash: H('9'),
      hash: H('a'),
      createdAt: DELETED,
    });
    const filters: Array<Record<string, unknown>> = [];
    const original = m.comments.updateOne;
    m.comments.updateOne = (...args: Parameters<typeof original>) => {
      filters.push(args[0]);
      return original(...args);
    };
    await service.run(RUN);
    m.comments.updateOne = original;
    expect(
      filters.filter((f) => 'commentId' in f && f.commentId === undefined),
    ).toEqual([]);
    // Its suggester is still removed.
    expect(
      m.versions.docs.find((v) => v.blockId === 'blkq' && v.seq === 3),
    ).not.toHaveProperty('suggestedBy');
  });

  it('records when the finished accept was decided, keeping a time already set', async () => {
    const { service, m } = scenario({ account: true, page: false });
    const sugg = m.comments.docs.find((c) => c.commentId === 'c-sugg-q')!;
    sugg.suggestion = { status: 'accepting', lockId: 'l1' };
    await service.run(RUN);
    expect((sugg.suggestion as { decidedAt?: Date }).decidedAt).toEqual(RUN);
    const again = scenario({ account: true, page: false });
    const earlier = new Date(DELETED.getTime() - 60_000);
    const kept = again.m.comments.docs.find((c) => c.commentId === 'c-sugg-q')!;
    kept.suggestion = { status: 'accepting', lockId: 'l1', decidedAt: earlier };
    await again.service.run(RUN);
    expect((kept.suggestion as { decidedAt?: Date }).decidedAt).toEqual(
      earlier,
    );
  });
});

describe('MemberPurgeService: round 10, 2', () => {
  it('removes the write gate of the account, whether or not its TTL ran', async () => {
    const { service, m } = scenario({ account: true, page: false });
    await service.run(RUN);
    expect(m.gates.docs.map((g) => g._id)).toEqual([writeGateId(OTHER)]);
  });
});
