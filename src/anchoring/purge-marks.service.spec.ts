import { Types } from 'mongoose';
import { PURGED_PERSON } from '../social/purge-rules';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { PurgeMarksService } from './purge-marks.service';
import { AnchorVerifierService } from './anchor-verifier.service';
import { purgeAfterOf } from '../member-data/member-data.constants';
import { accountDeletedRows } from './account-deletion-record';
import { buildTree, leafHash, MERKLE_SCHEME } from './merkle';
import {
  anchorLogFor,
  type AnchorModels,
  LOG_KEY,
} from './anchoring-harness.mocks-spec';
import { ANCHOR_LOG_ORIGIN } from './anchor-log-config';
import { checkpointText, parseSigner, signNote } from './signed-note';
import { makeTestTsa } from './test-tsa.mocks-spec';
import * as rfc3161 from './rfc3161';
import { redactionRow } from './redaction';
import { leafId } from './schemas/anchor-leaf.schema';
import type { VersionRecord } from './version-records';

// Chunk 17 review rounds 1-2: purgedAt alone proves nothing. A row counts
// as purged only with the exact purged shape AND its owner's mark; a row
// that lost a purged suggester is bound to its suggestion and to an
// anchored redaction record of what it keeps.
const AT = new Date('2031-11-14T03:00:00Z');
const PAGE = new Types.ObjectId();
const LIVE = new Types.ObjectId();
const ACCOUNT = new Types.ObjectId();
/** The webhook five years before the purge: purgeAfter is AT. */
const DELETED_AT = new Date('2026-11-14T03:00:00Z');
const DAY = 86_400_000;
const SALT = '2'.repeat(64);

const row = (extra: Partial<VersionRecord>): VersionRecord => ({
  _id: new Types.ObjectId(),
  key: 'blk',
  seq: 1,
  text: '',
  authorUserId: PURGED_PERSON,
  createdAt: AT,
  prevHash: '0'.repeat(64),
  hash: '1'.repeat(64),
  purgedAt: AT,
  ...extra,
});

/** A live version accepted from a suggestion, as it was before the purge. */
const accepted = row({
  key: 'live-blk',
  seq: 3,
  text: 'Accepted wording',
  authorUserId: 'user_owner',
  suggestionId: 'c-sugg',
});

type Entry = 'match' | 'missing' | 'otherHash' | 'otherLeaf' | 'badSalt';
/** How an anchor is signed: at a time, not at all, or by a token for another root. */
type Sign = Date | 'none' | 'other-root' | 'junk' | 'no-token';

// One synthetic TSA for the file (round 5: ages come from signed times).
const tsa = makeTestTsa();

/** An anchor's `leaves[]` entry and the claim for one stored row. */
function anchoredBy(
  anchorId: string,
  stored: { _id: Types.ObjectId; hash: string },
  claimHash = stored.hash,
  entry: Entry = 'match',
) {
  const claim = {
    _id: leafId('comment', stored._id),
    anchorId,
    versionHash: claimHash,
    salt: entry === 'badSalt' ? 'not-hex' : SALT,
  };
  const leaf = {
    kind: 'comment',
    versionId: stored._id,
    versionHash: entry === 'otherHash' ? '7'.repeat(64) : claimHash,
    leaf: entry === 'otherLeaf' ? '6'.repeat(64) : leafHash(claimHash, SALT),
  };
  return { claim, leaves: entry === 'missing' ? [] : [leaf] };
}

/** A built anchor with its root and, unless told otherwise, a token. */
function anchorDoc(
  _id: string,
  leaves: Array<{ leaf: string } & Record<string, unknown>>,
  sign: Sign,
  extra: Record<string, unknown> = {},
) {
  const root =
    leaves.length > 0 ? buildTree(leaves.map((l) => l.leaf)).root : undefined;
  return {
    _id,
    status: 'built',
    builtAt: sign instanceof Date ? sign : AT,
    leaves,
    // As a finished build writes them (read by the anchor log, Chunk 16b).
    scheme: MERKLE_SCHEME,
    leafCount: leaves.length,
    ...(root ? { merkleRoot: root } : {}),
    ...(root && sign !== 'none'
      ? {
          tsa: {
            response:
              sign === 'junk'
                ? Buffer.from('not a response')
                : tsa.respond(sign === 'other-root' ? '9'.repeat(64) : root, {
                    genTime: sign instanceof Date ? sign : AT,
                    noToken: sign === 'no-token',
                  }),
          },
        }
      : {}),
    ...extra,
  };
}

function marks({
  pageMark = 'purgedAt',
  commentMark = true,
  suggestion = {},
  redaction = 'anchored',
  leafHash: claimHash,
  entry = 'match',
  runs = [AT],
  noRuns = false,
  anchors = [],
  history = [],
  storedId,
  withAccounts = true,
  version = accepted,
  writtenAt = AT,
  recordAccount = ACCOUNT,
  deletion = 'anchored',
  deletionIds = ['c-other', 'c-sugg'],
  deletionSigned = new Date(DELETED_AT.getTime() + DAY),
  deletionAnchor = {},
  redactionSigned = new Date(AT.getTime() + DAY),
  deletionAt = DELETED_AT,
  accountAt = DELETED_AT,
  clock = new Date(AT.getTime() + 2 * DAY),
  versions = [accepted],
  ownLeavesExtra = [],
  ownAnchor = {},
  withLog = false,
}: {
  pageMark?: 'purgedAt' | 'purgeStartedAt' | 'none';
  commentMark?: boolean;
  suggestion?: Record<string, unknown>;
  redaction?: 'anchored' | 'building' | 'unclaimed' | 'none' | 'tampered';
  leafHash?: string;
  entry?: Entry;
  runs?: Date[];
  noRuns?: boolean;
  anchors?: Array<Record<string, unknown>>;
  /** Earlier anchors that held this redaction's leaf (round 6, 1a). */
  history?: Array<{
    hash: string;
    signed: Sign;
    /** The stored leaf, when it is not the salted leaf of `hash` (round 7). */
    leaf?: string;
    /** Fields to overwrite on that anchor after its root was taken. */
    extra?: Record<string, unknown>;
  }>;
  /** Store the redaction under another id than its own. */
  storedId?: Types.ObjectId;
  withAccounts?: boolean;
  version?: VersionRecord;
  writtenAt?: Date;
  recordAccount?: Types.ObjectId | string;
  deletion?:
    | 'anchored'
    | 'none'
    | 'unclaimed'
    | 'building'
    | 'tampered'
    | 'otherHash'
    | 'missingPart';
  deletionIds?: string[];
  deletionSigned?: Sign;
  /** Fields to overwrite on the deletion record's anchor (MEDIUM-2). */
  deletionAnchor?: Record<string, unknown>;
  redactionSigned?: Sign;
  deletionAt?: Date;
  accountAt?: Date;
  /** The verifier's now. */
  clock?: Date;
  /** The block versions that name a suggestion (MEDIUM-1). */
  versions?: VersionRecord[];
  /** Leaves added to the redaction's anchor after its root was taken. */
  ownLeavesExtra?: Array<{ leaf: string }>;
  /** Fields to overwrite on the redaction's own anchor (round 7, 3). */
  ownAnchor?: Record<string, unknown>;
  /** With the anchor log (Chunk 16b); `logOf` reaches it. Anchors get day ids. */
  withLog?: boolean;
} = {}) {
  const record = redactionRow(version, writtenAt, recordAccount);
  const stored = { ...record, _id: storedId ?? record._id };
  if (redaction === 'tampered')
    stored.text = stored.text.replace('suggestedBy', 'other');
  const anchorId = '2031-11-15';
  const own = anchoredBy(anchorId, stored, claimHash, entry);
  // The webhook's record, anchored the day after the deletion (#2).
  const parts = accountDeletedRows(ACCOUNT, deletionAt, deletionIds).map(
    (row) => ({ _id: new Types.ObjectId(), ...row }),
  );
  if (deletion === 'tampered')
    parts[0].text = parts[0].text.replace('c-', 'x-');
  const deletionAnchorId = '2026-11-15';
  const deletionClaims = parts.map((part) =>
    anchoredBy(
      deletionAnchorId,
      part,
      part.hash,
      deletion === 'otherHash' ? 'otherHash' : 'match',
    ),
  );
  const storedParts =
    deletion === 'none'
      ? []
      : deletion === 'missingPart'
        ? parts.slice(1)
        : parts;
  const anchorsModel = fakeModel([
    {
      ...anchorDoc(
        anchorId,
        // A building anchor has no leaves yet: they are set with `built`.
        redaction === 'unclaimed' || redaction === 'building' ? [] : own.leaves,
        redactionSigned,
        {
          status: redaction === 'building' ? 'building' : 'built',
        },
      ),
      ...(ownLeavesExtra.length > 0
        ? { leaves: [...own.leaves, ...ownLeavesExtra] }
        : {}),
      ...ownAnchor,
    },
    anchorDoc(
      deletionAnchorId,
      deletionClaims.flatMap((c) => c.leaves),
      deletionSigned,
      {
        status: deletion === 'building' ? 'building' : 'built',
        ...deletionAnchor,
      },
    ),
    ...history.map((h, i) => ({
      ...anchorDoc(
        withLog ? `2031-10-${10 + i}` : `hist-${i}`,
        [
          {
            kind: 'comment',
            versionId: stored._id,
            versionHash: h.hash,
            leaf: h.leaf ?? leafHash(h.hash, SALT),
          },
        ],
        h.signed,
      ),
      ...h.extra,
    })),
    ...anchors,
  ]);
  const service = new PurgeMarksService(
    fakeModel([
      {
        _id: PAGE,
        deletion: pageMark === 'none' ? { at: AT } : { at: AT, [pageMark]: AT },
      },
      { _id: LIVE },
    ]) as never,
    fakeModel([
      { blockId: 'blk', profileId: PAGE },
      { blockId: 'live-blk', profileId: LIVE, tabId: 'tab-live' },
      { blockId: 'other-blk', profileId: LIVE, tabId: 'tab-live' },
    ]) as never,
    fakeModel([{ tabId: 'tab1', profileId: PAGE }]) as never,
    fakeModel([
      { commentId: 'c1', ...(commentMark ? { purgedAt: AT } : {}) },
      {
        commentId: 'c-sugg',
        kind: 'suggestion',
        authorUserId: PURGED_PERSON,
        tabId: 'tab-live',
        suggestion: { resultSeq: 3 },
        ...(commentMark ? { purgedAt: AT } : {}),
        ...suggestion,
      },
    ]) as never,
    fakeModel([
      ...(redaction === 'none' ? [] : [stored]),
      ...storedParts,
    ]) as never,
    fakeModel([
      ...(redaction === 'unclaimed' ? [] : [own.claim]),
      ...(deletion === 'unclaimed' ? [] : deletionClaims.map((c) => c.claim)),
    ]) as never,
    anchorsModel as never,
    // The deleted account; its purge ran at `runs` (round 4, #1).
    (withAccounts
      ? fakeModel([
          {
            _id: ACCOUNT,
            userId: 'system:purged:x',
            at: accountAt,
            purgeAfter: purgeAfterOf(accountAt),
            ...(noRuns ? {} : { purgeRuns: runs }),
          },
        ])
      : undefined) as never,
    fakeModel(
      versions.map((v) => ({
        _id: v._id,
        blockId: v.key,
        seq: v.seq,
        suggestionId: v.suggestionId,
      })),
    ) as never,
  );
  service.trustedRoots = [tsa.root];
  service.now = () => clock;
  if (withLog) {
    const logged = anchorLogFor(
      { anchors: anchorsModel } as unknown as AnchorModels,
      tsa,
    );
    logged.log.now = () => clock;
    (service as unknown as { log: unknown }).log = logged.log;
    logs.set(service, { ...logged, anchors: anchorsModel });
  }
  return service;
}

const logs = new WeakMap<
  PurgeMarksService,
  ReturnType<typeof anchorLogFor> & { anchors: ReturnType<typeof fakeModel> }
>();
/** The anchor log of a `marks({ withLog: true })` service. */
const logOf = (service: PurgeMarksService) => logs.get(service)!;

describe('PurgeMarksService: content purges', () => {
  it('accepts a purged block version only on a page marked purged', async () => {
    expect(await marks().classify('block', row({}))).toBe('content');
    expect(
      await marks({ pageMark: 'purgeStartedAt' }).classify('block', row({})),
    ).toBe('content');
    expect(await marks().classify('block', row({ key: 'ttl_tab1' }))).toBe(
      'content',
    );
    expect(await marks({ pageMark: 'none' }).classify('block', row({}))).toBe(
      'invalid',
    );
    expect(await marks().classify('block', row({ key: 'live-blk' }))).toBe(
      'invalid',
    );
    expect(await marks().classify('block', row({ key: 'unknown' }))).toBe(
      'invalid',
    );
    expect(await marks().classify('block', row({ key: 'ttl_nope' }))).toBe(
      'invalid',
    );
  });

  it('refuses any other shape, even on a purged page', async () => {
    for (const changed of [
      { text: 'rewritten' },
      { authorUserId: 'user_someone' },
      { suggestedBy: 'user_someone' },
    ]) {
      expect(await marks().classify('block', row(changed))).toBe('invalid');
    }
  });

  it('accepts a purged comment version only when its comment is marked', async () => {
    expect(await marks().classify('comment', row({ key: 'c1' }))).toBe(
      'content',
    );
    expect(
      await marks({ commentMark: false }).classify(
        'comment',
        row({ key: 'c1' }),
      ),
    ).toBe('invalid');
    expect(
      await marks().classify('comment', row({ key: 'c1', text: 'x' })),
    ).toBe('invalid');
    expect(await marks().classify('comment', row({ key: 'nope' }))).toBe(
      'invalid',
    );
  });
});

describe('PurgeMarksService: a removed suggester (round 2, #1)', () => {
  it('proves everything but the removed id once the redaction is anchored', async () => {
    expect(await marks().classify('block', accepted)).toBe('suggester');
  });

  it('says pending until the redaction is in a built anchor', async () => {
    expect(
      await marks({ redaction: 'unclaimed' }).classify('block', accepted),
    ).toBe('suggester-pending');
    expect(
      await marks({ redaction: 'building' }).classify('block', accepted),
    ).toBe('suggester-pending');
  });

  it('FAILS rewritten text with a removed suggestedBy (the abuse case)', async () => {
    expect(
      await marks().classify('block', { ...accepted, text: 'Rewritten words' }),
    ).toBe('invalid');
    expect(
      await marks().classify('block', { ...accepted, hash: '9'.repeat(64) }),
    ).toBe('invalid');
    expect(
      await marks().classify('block', {
        ...accepted,
        prevHash: '8'.repeat(64),
      }),
    ).toBe('invalid');
  });

  it('FAILS without an intact redaction record', async () => {
    expect(await marks({ redaction: 'none' }).classify('block', accepted)).toBe(
      'invalid',
    );
    expect(
      await marks({ redaction: 'tampered' }).classify('block', accepted),
    ).toBe('invalid');
  });

  it('binds the suggestion: purged, by no one, on this tab, writing this version', async () => {
    for (const suggestion of [
      { kind: 'comment' },
      { authorUserId: 'user_x' },
      { tabId: 'other-tab' },
      { suggestion: { resultSeq: 2 } },
      { suggestion: undefined },
    ]) {
      expect(await marks({ suggestion }).classify('block', accepted)).toBe(
        'invalid',
      );
    }
    expect(
      await marks({ commentMark: false }).classify('block', accepted),
    ).toBe('invalid');
    expect(
      await marks().classify('block', { ...accepted, suggestionId: 'nope' }),
    ).toBe('invalid');
    expect(
      await marks().classify('block', { ...accepted, key: 'unknown' }),
    ).toBe('invalid');
  });

  // Round 3, H-1: the reviewer's probe, scenarios A and B.
  it('A: FAILS tampered text whose redaction was rewritten after its anchor', async () => {
    const tampered = { ...accepted, text: 'Attacker words' };
    const honestHash = redactionRow(accepted, AT, ACCOUNT).hash;
    expect(
      await marks({ version: tampered, leafHash: honestHash }).classify(
        'block',
        tampered,
      ),
    ).toBe('invalid');
  });

  // Round 3, H-1b as an evidence rule: an unclaimed record FAILS only when
  // a completed anchor that should have claimed it did not.
  const builtLater = (extra: Record<string, unknown> = {}) => ({
    _id: 'later',
    status: 'built',
    cutoff: new Date(AT.getTime() + DAY),
    builtAt: new Date(AT.getTime() + 2 * DAY),
    ...extra,
  });

  it('B: FAILS a forged, back-dated record that a later anchor did not claim', async () => {
    const tampered = { ...accepted, text: 'Attacker words' };
    const old = new Date('2020-01-01T00:00:00Z');
    expect(
      await marks({
        version: tampered,
        redaction: 'unclaimed',
        writtenAt: old,
        runs: [old],
        // Everything else genuine, so only the missed claim can fail it.
        accountAt: new Date('2015-01-01T00:00:00Z'),
        deletionAt: new Date('2015-01-01T00:00:00Z'),
        deletionSigned: new Date('2020-02-01T00:00:00Z'),
        anchors: [builtLater()],
      }).classify('block', tampered),
    ).toBe('invalid');
  });

  it('stays pending while the server slept for 5 days and no anchor was built', async () => {
    expect(
      await marks({ redaction: 'unclaimed', anchors: [] }).classify(
        'block',
        accepted,
      ),
    ).toBe('suggester-pending');
    // An anchor from BEFORE the record proves nothing either.
    const earlier = builtLater({
      cutoff: new Date(AT.getTime() - DAY),
      builtAt: new Date(AT.getTime() - DAY),
    });
    expect(
      await marks({ redaction: 'unclaimed', anchors: [earlier] }).classify(
        'block',
        accepted,
      ),
    ).toBe('suggester-pending');
    // Built too soon after the record (it may already have been running).
    const tooSoon = builtLater({ builtAt: new Date(AT.getTime() + DAY / 2) });
    expect(
      await marks({ redaction: 'unclaimed', anchors: [tooSoon] }).classify(
        'block',
        accepted,
      ),
    ).toBe('suggester-pending');
    // Built late (a dead build resumed) but its cutoff was before the record.
    const resumed = builtLater({ cutoff: new Date(AT.getTime() - 1) });
    expect(
      await marks({ redaction: 'unclaimed', anchors: [resumed] }).classify(
        'block',
        accepted,
      ),
    ).toBe('suggester-pending');
    // Still building: not a finished run.
    expect(
      await marks({
        redaction: 'unclaimed',
        anchors: [builtLater({ status: 'building' })],
      }).classify('block', accepted),
    ).toBe('suggester-pending');
  });

  it('is proven once an anchor built afterwards claims it', async () => {
    expect(
      await marks({ anchors: [builtLater()] }).classify('block', accepted),
    ).toBe('suggester');
  });

  it('FAILS a record that a later anchor under the cap did not claim, empty days included', async () => {
    expect(
      await marks({ redaction: 'unclaimed', anchors: [builtLater()] }).classify(
        'block',
        accepted,
      ),
    ).toBe('invalid');
    expect(
      await marks({
        redaction: 'unclaimed',
        anchors: [builtLater({ status: 'empty' })],
      }).classify('block', accepted),
    ).toBe('invalid');
  });

  it('stays pending after an anchor that hit the cap before it, or was rescanning it', async () => {
    const capped = builtLater({ resumeFrom: new Date(AT.getTime() - 1) });
    expect(
      await marks({ redaction: 'unclaimed', anchors: [capped] }).classify(
        'block',
        accepted,
      ),
    ).toBe('suggester-pending');
    const rescanning = builtLater({
      rescanFrom: new Date(AT.getTime() - 1),
      rescanTo: new Date(AT.getTime() + 1),
    });
    expect(
      await marks({ redaction: 'unclaimed', anchors: [rescanning] }).classify(
        'block',
        accepted,
      ),
    ).toBe('suggester-pending');
    // A cap reached AFTER the record: it should have been claimed.
    const cappedLater = builtLater({ resumeFrom: new Date(AT.getTime() + 1) });
    expect(
      await marks({ redaction: 'unclaimed', anchors: [cappedLater] }).classify(
        'block',
        accepted,
      ),
    ).toBe('invalid');
  });

  // Round 4, #1: the record's time must be one of its account's purge runs,
  // however long after the first run a retry lands.
  it('F: proves an honest record written by a rerun days after the first run', async () => {
    const first = new Date(AT.getTime() - 2 * DAY);
    expect(await marks({ runs: [first, AT] }).classify('block', accepted)).toBe(
      'suggester',
    );
    expect(
      await marks({ runs: [first, AT], redaction: 'unclaimed' }).classify(
        'block',
        accepted,
      ),
    ).toBe('suggester-pending');
  });

  it('FAILS a record whose time is not one of its account purge runs', async () => {
    for (const runs of [
      [new Date(AT.getTime() - 1)],
      [new Date(AT.getTime() + 60_000)],
      [],
    ]) {
      expect(await marks({ runs }).classify('block', accepted)).toBe('invalid');
    }
    expect(
      await marks({ withAccounts: false }).classify('block', accepted),
    ).toBe('invalid');
    expect(await marks({ noRuns: true }).classify('block', accepted)).toBe(
      'invalid',
    );
    expect(
      await marks({ recordAccount: 'not-an-id' }).classify('block', accepted),
    ).toBe('invalid');
  });

  // Round 4, #2: a redaction stands only on its account's deletion record,
  // anchored years before.
  it('E: FAILS a fresh forgery that has no anchored account-deletion record', async () => {
    const tampered = { ...accepted, text: 'Attacker words' };
    for (const deletion of [
      'none',
      'unclaimed',
      'building',
      'tampered',
      'otherHash',
    ] as const) {
      expect(
        await marks({ version: tampered, deletion }).classify(
          'block',
          tampered,
        ),
      ).toBe('invalid');
    }
    // Planted now and anchored tomorrow: far too recent.
    expect(
      await marks({
        version: tampered,
        deletionSigned: new Date(AT.getTime() + DAY),
      }).classify('block', tampered),
    ).toBe('invalid');
  });

  it('FAILS a suggestion the account had not authored when it was deleted', async () => {
    expect(
      await marks({ deletionIds: ['c-other'] }).classify('block', accepted),
    ).toBe('invalid');
    expect(await marks({ deletionIds: [] }).classify('block', accepted)).toBe(
      'invalid',
    );
  });

  it('FAILS a deletion anchored too recently, and accepts one up to a year late', async () => {
    const late = (days: number, ms = 0) =>
      marks({
        deletionSigned: new Date(DELETED_AT.getTime() + days * DAY + ms),
      }).classify('block', accepted);
    expect(await late(200)).toBe('suggester');
    expect(await late(366)).toBe('suggester');
    expect(await late(366, 1)).toBe('invalid');
    expect(await late(1000)).toBe('invalid');
  });

  it('binds the record to its own account, its time and its five years', async () => {
    expect(
      await marks({ recordAccount: new Types.ObjectId() }).classify(
        'block',
        accepted,
      ),
    ).toBe('invalid');
    // The account row's time is not the anchored one.
    expect(
      await marks({ accountAt: new Date(DELETED_AT.getTime() - DAY) }).classify(
        'block',
        accepted,
      ),
    ).toBe('invalid');
    // A run before the account's five years were up.
    const early = new Date(AT.getTime() - DAY);
    expect(
      await marks({ runs: [early], writtenAt: early }).classify(
        'block',
        accepted,
      ),
    ).toBe('invalid');
  });

  it('reads a long list over its linked parts, and FAILS a missing part', async () => {
    const many = [
      ...Array.from(
        { length: 300 },
        (_, i) => `c-${String(i).padStart(4, '0')}`,
      ),
      'c-sugg',
    ];
    expect(await marks({ deletionIds: many }).classify('block', accepted)).toBe(
      'suggester',
    );
    expect(
      await marks({ deletionIds: many, deletion: 'missingPart' }).classify(
        'block',
        accepted,
      ),
    ).toBe('invalid');
    expect(
      await marks({ deletion: 'missingPart' }).classify('block', accepted),
    ).toBe('invalid');
  });

  // Round 4, #3: the per-version check reads the anchor's own leaf.
  it('H: FAILS a redaction whose claim was rewritten along with it', async () => {
    for (const entry of ['otherHash', 'otherLeaf', 'badSalt'] as const) {
      expect(await marks({ entry }).classify('block', accepted)).toBe(
        'invalid',
      );
    }
    // A claim outside its anchor's tree is stray, not anchored: pending
    // until the sweep releases it.
    expect(await marks({ entry: 'missing' }).classify('block', accepted)).toBe(
      'suggester-pending',
    );
  });

  // Round 4, #4: a released claim waits for its rescan, never a FAIL.
  it('G: stays pending while the newest anchor, or a release after it, reaches the record (round 6, 2)', async () => {
    const clock = new Date(AT.getTime() + 4 * DAY);
    // Released after the newest build finished: the next build covers it.
    const releaser = builtLater({
      _id: 'rel',
      builtAt: new Date(AT.getTime() + DAY / 2),
      rescanFrom: AT,
      rescanTo: AT,
      rescanAt: new Date(AT.getTime() + 3 * DAY),
    });
    expect(
      await marks({
        redaction: 'unclaimed',
        anchors: [releaser, builtLater()],
        clock,
      }).classify('block', accepted),
    ).toBe('suggester-pending');
    // The newest anchor itself capped, or rescanning, before the record.
    for (const point of [
      { resumeOpen: true, resumeFrom: new Date(AT.getTime() - 1) },
      { rescanFrom: new Date(AT.getTime() - 1), rescanTo: AT },
    ]) {
      expect(
        await marks({
          redaction: 'unclaimed',
          anchors: [
            builtLater(),
            builtLater({
              _id: 'newest',
              builtAt: new Date(AT.getTime() + 3 * DAY),
              ...point,
            }),
          ],
          clock,
        }).classify('block', accepted),
      ).toBe('suggester-pending');
    }
  });

  it('r6b: ignores reach points planted on older anchors', async () => {
    const clock = new Date(AT.getTime() + 4 * DAY);
    for (const planted of [
      { rescanFrom: new Date(0) },
      { resumeOpen: true, resumeFrom: new Date(0) },
      // Released "before" the newest build, or dated ahead of now.
      { rescanFrom: new Date(0), rescanAt: new Date(AT.getTime() + DAY) },
      { rescanFrom: new Date(0), rescanAt: new Date(clock.getTime() + DAY) },
    ]) {
      expect(
        await marks({
          redaction: 'unclaimed',
          anchors: [
            { _id: 'old-2027', status: 'built', ...planted },
            builtLater(),
          ],
          clock,
        }).classify('block', accepted),
      ).toBe('invalid');
    }
    // Points on the newest anchor that do not reach the record prove nothing.
    for (const point of [
      { rescanFrom: new Date(AT.getTime() + 1) },
      { resumeFrom: new Date(AT.getTime() - 1) },
      { resumeOpen: true, resumeFrom: new Date(AT.getTime() + 1) },
    ]) {
      expect(
        await marks({
          redaction: 'unclaimed',
          anchors: [
            builtLater(),
            builtLater({
              _id: 'newest',
              builtAt: new Date(AT.getTime() + 3 * DAY),
              ...point,
            }),
          ],
          clock,
        }).classify('block', accepted),
      ).toBe('invalid');
    }
  });

  it('refuses the suggester shape when anything else differs', async () => {
    expect(
      await marks().classify('block', { ...accepted, suggestedBy: 'user_x' }),
    ).toBe('invalid');
    expect(
      await marks().classify('block', { ...accepted, suggestionId: undefined }),
    ).toBe('invalid');
  });
});

describe('PurgeMarksService: ages by signed time (round 5)', () => {
  const tampered = { ...accepted, text: 'Attacker words' };
  // The attacker acts on T0: a forged account row "deleted" that day, its
  // record anchored honestly the next day.
  const T0 = new Date('2027-01-10T03:00:00Z');
  const fresh = {
    version: tampered,
    accountAt: T0,
    deletionAt: T0,
    deletionSigned: new Date(T0.getTime() + DAY),
  };

  it('HIGH-1: FAILS a forgery made today and dated five years ahead', async () => {
    const ahead = purgeAfterOf(T0);
    expect(
      await marks({
        ...fresh,
        writtenAt: ahead,
        runs: [ahead],
        redaction: 'unclaimed',
        clock: new Date(T0.getTime() + 2 * DAY),
      }).classify('block', tampered),
    ).toBe('invalid');
  });

  it('HIGH-1: FAILS a record claiming 2031 whose own anchor was signed years earlier', async () => {
    const claimed = purgeAfterOf(T0);
    expect(
      await marks({
        ...fresh,
        writtenAt: claimed,
        runs: [claimed],
        redactionSigned: new Date(T0.getTime() + 2 * DAY),
        clock: new Date(claimed.getTime() + 2 * DAY),
      }).classify('block', tampered),
    ).toBe('invalid');
  });

  it('allows five minutes of clock skew, not more', async () => {
    expect(
      await marks({ clock: new Date(AT.getTime() - 4 * 60_000) }).classify(
        'block',
        accepted,
      ),
    ).toBe('suggester');
    expect(
      await marks({ clock: new Date(AT.getTime() - 6 * 60_000) }).classify(
        'block',
        accepted,
      ),
    ).toBe('invalid');
  });

  it('MEDIUM-2: an edited builtAt, root or leaf list proves nothing', async () => {
    expect(
      await marks({
        ...fresh,
        runs: [AT],
        writtenAt: AT,
        accountAt: DELETED_AT,
        deletionAt: DELETED_AT,
        deletionSigned: new Date(AT.getTime() - DAY),
        deletionAnchor: { builtAt: new Date('2026-11-15T00:00:00Z') },
      }).classify('block', tampered),
    ).toBe('invalid');
    expect(
      await marks({ deletionAnchor: { merkleRoot: 'f'.repeat(64) } }).classify(
        'block',
        accepted,
      ),
    ).toBe('invalid');
    expect(
      await marks({
        anchors: [],
        redactionSigned: new Date(AT.getTime() + DAY),
        deletionAnchor: { merkleRoot: undefined },
      }).classify('block', accepted),
    ).toBe('invalid');
  });

  it('MEDIUM-2: FAILS an anchor whose leaf list no longer builds a tree', async () => {
    expect(
      await marks({ ownLeavesExtra: [{ leaf: 'not-a-hash' }] }).classify(
        'block',
        accepted,
      ),
    ).toBe('invalid');
  });

  it('HIGH-1c: stays pending while an anchor has no verified signed time', async () => {
    for (const sign of ['none', 'other-root', 'junk', 'no-token'] as const) {
      // A signed later anchor ends nothing (round 8): both stay pending.
      expect(
        await marks({ deletionSigned: sign, redactionSigned: 'none' }).classify(
          'block',
          accepted,
        ),
      ).toBe('suggester-pending');
      expect(
        await marks({ deletionSigned: sign }).classify('block', accepted),
      ).toBe('suggester-pending');
      expect(
        await marks({ redactionSigned: sign }).classify('block', accepted),
      ).toBe('suggester-pending');
    }
  });
});

describe('PurgeMarksService: one version per suggestion (round 5, MEDIUM-1)', () => {
  // A DIFFERENT block of the same tab citing the same purged suggestion.
  const other = row({
    key: 'other-blk',
    seq: 3,
    text: 'Attacker words',
    authorUserId: 'user_owner',
    suggestionId: 'c-sugg',
  });

  it('FAILS a second version citing the same suggestion, and the first with it', async () => {
    const both = [accepted, other];
    expect(
      await marks({ version: other, versions: both }).classify('block', other),
    ).toBe('invalid');
    expect(await marks({ versions: both }).classify('block', accepted)).toBe(
      'invalid',
    );
    expect(await marks({ versions: [] }).classify('block', accepted)).toBe(
      'invalid',
    );
  });

  it('checks the recorded block when the suggestion has one', async () => {
    expect(
      await marks({
        suggestion: { suggestion: { resultSeq: 3, resultBlockId: 'live-blk' } },
      }).classify('block', accepted),
    ).toBe('suggester');
    expect(
      await marks({
        suggestion: {
          suggestion: { resultSeq: 3, resultBlockId: 'other-blk' },
        },
      }).classify('block', accepted),
    ).toBe('invalid');
  });

  it('FAILS without the block versions to check against', async () => {
    const service = marks();
    (service as unknown as { blockVersionModel?: unknown }).blockVersionModel =
      undefined;
    expect(await service.classify('block', accepted)).toBe('invalid');
  });
});

describe('PurgeMarksService: its clock', () => {
  it('reads the real time unless a test sets one', () => {
    const service = new PurgeMarksService(
      ...(Array.from({ length: 7 }, () => fakeModel([])) as never as [
        never,
        never,
        never,
        never,
        never,
        never,
        never,
      ]),
    );
    expect(Math.abs(service.now().getTime() - Date.now())).toBeLessThan(5_000);
  });
});

describe('PurgeMarksService: a redaction re-issued after the purge (round 6, 1)', () => {
  const tampered = { ...accepted, text: 'Words the owner never accepted' };
  const FORGE = new Date('2033-02-01T03:00:00Z');

  it('r6a: FAILS a re-issued redaction at a later run pushed onto purgeRuns', async () => {
    expect(
      await marks({
        version: tampered,
        writtenAt: FORGE,
        runs: [AT, FORGE],
        redactionSigned: new Date(FORGE.getTime() + DAY),
        clock: new Date(FORGE.getTime() + 2 * DAY),
      }).classify('block', tampered),
    ).toBe('invalid');
  });

  it('1a: FAILS when an earlier verified anchor held another hash for its leaf', async () => {
    const honest = redactionRow(accepted, AT, ACCOUNT).hash;
    expect(
      await marks({
        version: tampered,
        history: [{ hash: honest, signed: new Date(AT.getTime() + DAY) }],
        redactionSigned: new Date(AT.getTime() + 3 * DAY),
      }).classify('block', tampered),
    ).toBe('invalid');
    // An unverified holder with another hash FAILS too (round 7, 2): its
    // token may simply have been removed.
    expect(
      await marks({
        history: [{ hash: '4'.repeat(64), signed: 'none' }],
      }).classify('block', accepted),
    ).toBe('invalid');
  });

  it('1a: FAILS a redaction stored under any id but its own', async () => {
    expect(
      await marks({ storedId: new Types.ObjectId() }).classify(
        'block',
        accepted,
      ),
    ).toBe('invalid');
  });

  it('1b: FAILS a redaction signed more than five years and the margin after the deletion', async () => {
    expect(
      await marks({
        redactionSigned: new Date(AT.getTime() + 400 * DAY),
      }).classify('block', accepted),
    ).toBe('invalid');
    expect(
      await marks({
        redactionSigned: new Date(AT.getTime() + 300 * DAY),
      }).classify('block', accepted),
    ).toBe('suggester');
  });
});

describe('PurgeMarksService: anchors with no token (round 6, 3)', () => {
  const clock = new Date(AT.getTime() + 2 * DAY);
  // Both unsigned, so no later signed build ends the wait (round 7, 3).
  const unsignedAged = (days: number) => ({
    deletionSigned: 'none' as const,
    redactionSigned: 'none' as const,
    deletionAnchor: { builtAt: new Date(clock.getTime() - days * DAY) },
    clock,
  });

  it('is pending only inside the TSA retry window', async () => {
    expect(await marks(unsignedAged(3)).classify('block', accepted)).toBe(
      'suggester-pending',
    );
    expect(await marks(unsignedAged(40)).classify('block', accepted)).toBe(
      'invalid',
    );
    expect(
      await marks({
        redactionSigned: 'none',
        clock: new Date(AT.getTime() + 40 * DAY),
      }).classify('block', accepted),
    ).toBe('invalid');
  });

  it('FAILS a back-dated forgery a later anchor missed, even on a token-less deletion', async () => {
    const tampered = { ...accepted, text: 'Attacker words' };
    const t = new Date(AT.getTime() - 3 * DAY);
    expect(
      await marks({
        ...unsignedAged(1),
        version: tampered,
        redaction: 'unclaimed',
        writtenAt: AT,
        anchors: [
          {
            _id: 'later',
            status: 'built',
            cutoff: new Date(AT.getTime() + DAY),
            builtAt: new Date(AT.getTime() + 2 * DAY),
          },
        ],
        runs: [AT, t],
      }).classify('block', tampered),
    ).toBe('invalid');
  });
});

describe('PurgeMarksService: an accept left unmarked (round 6, 4)', () => {
  it('accepts a missing resultSeq only while the suggestion is accepting', async () => {
    expect(
      await marks({
        suggestion: { suggestion: { status: 'accepting' } },
      }).classify('block', accepted),
    ).toBe('suggester');
    expect(
      await marks({
        suggestion: { suggestion: { status: 'pending' } },
      }).classify('block', accepted),
    ).toBe('invalid');
  });
});

describe('PurgeMarksService: anchor checks are cached (round 6, 6)', () => {
  it('loads and verifies one anchor shared by several parts once', async () => {
    const many = [
      ...Array.from(
        { length: 600 },
        (_, i) => `c-${String(i).padStart(4, '0')}`,
      ),
      'c-sugg',
    ];
    const service = marks({ deletionIds: many });
    const anchors = (
      service as unknown as {
        anchorModel: { findOne: (...a: unknown[]) => unknown };
      }
    ).anchorModel;
    const original = anchors.findOne;
    const loads: string[] = [];
    anchors.findOne = (filter: unknown, ...rest: unknown[]) => {
      const query = original(filter, ...rest) as {
        select: (s: Record<string, unknown>) => unknown;
      };
      const select = query.select;
      query.select = (fields: Record<string, unknown>) => {
        if (fields.leaves === 1) {
          loads.push(String((filter as { _id?: unknown })._id));
        }
        return select(fields);
      };
      return query;
    };
    const verify = jest.spyOn(rfc3161, 'verifyTimestampToken');
    expect(await service.classify('block', accepted)).toBe('suggester');
    expect(loads.filter((id) => id === '2026-11-15')).toHaveLength(1);
    // Two anchors in all: the deletion record's and the redaction's.
    expect(verify).toHaveBeenCalledTimes(2);
    verify.mockRestore();
  });
});

describe('PurgeMarksService: a small anchor cache', () => {
  it('still answers when it can hold only one anchor', async () => {
    const service = marks();
    service.anchorCacheSize = 1;
    expect(await service.classify('block', accepted)).toBe('suggester');
  });
});

describe('PurgeMarksService: edges of the anchor memory', () => {
  const bare = () =>
    new PurgeMarksService(
      ...(Array.from({ length: 7 }, () => fakeModel([])) as never as [
        never,
        never,
        never,
        never,
        never,
        never,
        never,
      ]),
    ) as unknown as {
      missedBy: (at: Date) => Promise<boolean>;
      checkedAnchor: (
        head: object,
      ) => Promise<{ entries: Map<string, unknown> }>;
    };

  it('misses nothing before any anchor was finished', async () => {
    await expect(bare().missedBy(AT)).resolves.toBe(false);
  });

  it('reads an anchor gone since its head was read as holding nothing', async () => {
    const checked = await bare().checkedAnchor({
      _id: 'gone',
      status: 'built',
    });
    expect(checked.entries.size).toBe(0);
  });

  it('FAILS an anchor that holds it when its claim is gone (round 7, 1)', async () => {
    const hash = redactionRow(accepted, AT, ACCOUNT).hash;
    expect(
      await marks({
        redaction: 'unclaimed',
        history: [{ hash, signed: new Date(AT.getTime() + DAY) }],
      }).classify('block', accepted),
    ).toBe('invalid');
  });
});

describe('PurgeMarksService: round 6, 1c', () => {
  it('FAILS a record dated after its own first signed anchor time', async () => {
    expect(
      await marks({
        redactionSigned: new Date(AT.getTime() - 60 * 60 * 1000),
      }).classify('block', accepted),
    ).toBe('invalid');
  });
});

describe('PurgeMarksService: every anchor holding a redaction (round 7, 1-2)', () => {
  const tampered = { ...accepted, text: 'Words the owner never accepted' };
  const honest = redactionRow(accepted, AT, ACCOUNT).hash;
  const forged = redactionRow(tampered, AT, ACCOUNT).hash;
  const FORGE = new Date(AT.getTime() + 200 * DAY);

  it('r7a: FAILS an anchor whose stored hash was edited and whose claim is gone', async () => {
    expect(
      await marks({
        version: tampered,
        redaction: 'unclaimed',
        history: [
          {
            hash: forged,
            leaf: leafHash(honest, SALT),
            signed: new Date(AT.getTime() + DAY),
          },
        ],
      }).classify('block', tampered),
    ).toBe('invalid');
    // A holder with no claim at all, even an honest one, proves nothing.
    expect(
      await marks({
        redaction: 'unclaimed',
        history: [{ hash: honest, signed: new Date(AT.getTime() + DAY) }],
      }).classify('block', accepted),
    ).toBe('invalid');
  });

  it('FAILS a holder whose stored leaf is not the salted leaf of its stored hash', async () => {
    expect(
      await marks({
        history: [
          {
            hash: honest,
            leaf: leafHash('4'.repeat(64), SALT),
            signed: new Date(AT.getTime() + 2 * DAY),
          },
        ],
      }).classify('block', accepted),
    ).toBe('invalid');
  });

  it('FAILS when the claim is not on the earliest signed holder', async () => {
    expect(
      await marks({
        history: [{ hash: honest, signed: new Date(AT.getTime() + DAY) }],
        redactionSigned: new Date(AT.getTime() + 3 * DAY),
      }).classify('block', accepted),
    ).toBe('invalid');
  });

  it('FAILS any holder that is not built, or whose root does not rebuild', async () => {
    for (const extra of [
      { status: 'empty' },
      { status: 'building' },
      { merkleRoot: 'f'.repeat(64) },
    ]) {
      expect(
        await marks({
          history: [
            { hash: honest, signed: new Date(AT.getTime() + 2 * DAY), extra },
          ],
        }).classify('block', accepted),
      ).toBe('invalid');
    }
  });

  it('FAILS a holder that lists the id under another kind', async () => {
    const { _id } = redactionRow(accepted, AT, ACCOUNT);
    expect(
      await marks({
        history: [
          {
            hash: honest,
            signed: new Date(AT.getTime() + 2 * DAY),
            extra: {
              leaves: [
                {
                  kind: 'block',
                  versionId: _id,
                  versionHash: honest,
                  leaf: leafHash(honest, SALT),
                },
              ],
            },
          },
        ],
      }).classify('block', accepted),
    ).toBe('invalid');
  });

  it('r7b: FAILS a fresh re-stamp while the honest holder is hidden', async () => {
    for (const extra of [
      { status: 'empty' },
      { merkleRoot: 'f'.repeat(64) },
      { tsa: undefined },
    ]) {
      expect(
        await marks({
          version: tampered,
          history: [
            { hash: honest, signed: new Date(AT.getTime() + DAY), extra },
          ],
          redactionSigned: FORGE,
          clock: new Date(FORGE.getTime() + DAY),
        }).classify('block', tampered),
      ).toBe('invalid');
    }
    // The control: the same timeline with no honest holder is proven.
    expect(
      await marks({
        redactionSigned: FORGE,
        clock: new Date(FORGE.getTime() + DAY),
      }).classify('block', accepted),
    ).toBe('suggester');
  });
});

describe('PurgeMarksService: an unsigned claim (round 7, 3; round 8)', () => {
  const H = 60 * 60 * 1000;
  /** A later, unrelated build: built at `built`, its token signed at `signed`. */
  const laterBuild = (built: Date, signed: Date) => ({
    ...anchorDoc(
      `later-${built.getTime()}`,
      [{ leaf: '5'.repeat(64) }],
      signed,
    ),
    builtAt: built,
  });
  // Each anchor has its own TSA backoff (up to a day) and the server may
  // sleep, so a newer anchor being signed says nothing about this one.
  const unsignedOwn = {
    redactionSigned: 'none' as const,
    ownAnchor: { builtAt: new Date(AT.getTime() + 21 * H) },
  };

  it('r8a: stays pending under a flaky FreeTSA after a newer build was signed', async () => {
    expect(
      await marks({
        ...unsignedOwn,
        anchors: [
          laterBuild(
            new Date(AT.getTime() + 45 * H),
            new Date(AT.getTime() + 46 * H),
          ),
        ],
        clock: new Date(AT.getTime() + 71 * H),
      }).classify('block', accepted),
    ).toBe('suggester-pending');
  });

  it('r8b: stays pending when the server slept through its own retry', async () => {
    expect(
      await marks({
        ...unsignedOwn,
        anchors: [
          laterBuild(
            new Date(AT.getTime() + 45 * H),
            new Date(AT.getTime() + 60 * H),
          ),
        ],
        clock: new Date(AT.getTime() + 85 * H),
      }).classify('block', accepted),
    ).toBe('suggester-pending');
  });

  it('is pending for SWEEP_DAYS from its build, then FAILS', async () => {
    const built = new Date(AT.getTime() + 21 * H);
    for (const [days, verdict] of [
      [29, 'suggester-pending'],
      [31, 'invalid'],
    ] as const) {
      expect(
        await marks({
          ...unsignedOwn,
          clock: new Date(built.getTime() + days * DAY),
        }).classify('block', accepted),
      ).toBe(verdict);
    }
  });

  it('a deletion part on an unsigned anchor follows the same rule', async () => {
    const built = new Date(AT.getTime() + 21 * H);
    expect(
      await marks({
        ...unsignedOwn,
        deletionSigned: 'none',
        deletionAnchor: { builtAt: new Date(AT.getTime()) },
        anchors: [
          laterBuild(
            new Date(AT.getTime() + 45 * H),
            new Date(AT.getTime() + 46 * H),
          ),
        ],
        clock: new Date(built.getTime() + 3 * DAY),
      }).classify('block', accepted),
    ).toBe('suggester-pending');
    expect(
      await marks({
        ...unsignedOwn,
        deletionSigned: 'none',
        deletionAnchor: { builtAt: new Date(AT.getTime() - 31 * DAY) },
        clock: new Date(AT.getTime() + 2 * DAY),
      }).classify('block', accepted),
    ).toBe('invalid');
  });

  it('allows five minutes of clock skew on an unsigned anchor', async () => {
    const clock = new Date(AT.getTime() + 3 * DAY);
    expect(
      await marks({
        redactionSigned: 'none',
        ownAnchor: { builtAt: new Date(clock.getTime() + 2 * 60_000) },
        clock,
      }).classify('block', accepted),
    ).toBe('suggester-pending');
  });

  it('FAILS an unsigned anchor dated ahead of the clock', async () => {
    const clock = new Date(AT.getTime() + 3 * DAY);
    expect(
      await marks({
        redactionSigned: 'none',
        ownAnchor: { builtAt: new Date(clock.getTime() + DAY) },
        clock,
      }).classify('block', accepted),
    ).toBe('invalid');
    expect(
      await marks({
        deletionSigned: 'none',
        redactionSigned: 'none',
        deletionAnchor: { builtAt: new Date(clock.getTime() + DAY) },
        clock,
      }).classify('block', accepted),
    ).toBe('invalid');
  });
});

describe('PurgeMarksService: one anchor check per request (round 7, 7)', () => {
  /** A live page with `n` versions, each from a purged suggestion. */
  function report(n: number) {
    const versions = Array.from({ length: n }, (_, i) =>
      row({
        key: `live-${i}`,
        seq: 3,
        text: 'Accepted wording',
        authorUserId: 'user_owner',
        suggestionId: `c-s${i}`,
        hash: String(i + 1).repeat(64),
      }),
    );
    const redactions = versions.map((v) => redactionRow(v, AT, ACCOUNT));
    const parts = accountDeletedRows(
      ACCOUNT,
      DELETED_AT,
      versions.map((v) => v.suggestionId!),
    ).map((part) => ({ _id: new Types.ObjectId(), ...part }));
    const own = redactions.map((r) => anchoredBy('R', r));
    const dels = parts.map((p) => anchoredBy('D', p));
    // The first version on page anchor P, the rest on Q: the report must
    // not start afresh between them.
    const pageOf = (i: number) => (i === 0 ? 'P' : 'Q');
    const pages = versions.map((v, i) => ({
      claim: {
        _id: leafId('block', v._id),
        anchorId: pageOf(i),
        versionHash: v.hash,
        salt: SALT,
      },
      leaf: {
        kind: 'block',
        versionId: v._id,
        versionHash: v.hash,
        leaf: leafHash(v.hash, SALT),
      },
    }));
    const anchors = fakeModel([
      anchorDoc(
        'R',
        own.flatMap((o) => o.leaves),
        new Date(AT.getTime() + DAY),
      ),
      anchorDoc(
        'D',
        dels.flatMap((d) => d.leaves),
        new Date(DELETED_AT.getTime() + DAY),
      ),
      ...['P', 'Q'].map((page) =>
        anchorDoc(
          page,
          pages.filter((p) => p.claim.anchorId === page).map((p) => p.leaf),
          new Date('2027-01-02'),
        ),
      ),
    ]);
    const leaves = fakeModel([
      ...own.map((o) => o.claim),
      ...dels.map((d) => d.claim),
      ...pages.map((p) => p.claim),
    ]);
    const blockVersions = fakeModel(
      versions.map(({ key, ...v }) => ({ ...v, blockId: key })),
    );
    const commentVersions = fakeModel([...redactions, ...parts]);
    const marks = new PurgeMarksService(
      fakeModel([{ _id: LIVE }]) as never,
      fakeModel(
        versions.map((v) => ({
          blockId: v.key,
          profileId: LIVE,
          tabId: 'tab-live',
        })),
      ) as never,
      fakeModel([]) as never,
      fakeModel(
        versions.map((v) => ({
          commentId: v.suggestionId,
          kind: 'suggestion',
          authorUserId: PURGED_PERSON,
          tabId: 'tab-live',
          suggestion: { resultSeq: 3 },
          purgedAt: AT,
        })),
      ) as never,
      commentVersions as never,
      leaves as never,
      anchors as never,
      fakeModel([
        {
          _id: ACCOUNT,
          userId: 'system:purged:x',
          at: DELETED_AT,
          purgeAfter: purgeAfterOf(DELETED_AT),
          purgeRuns: [AT],
        },
      ]) as never,
      blockVersions as never,
    );
    marks.trustedRoots = [tsa.root];
    const clock = new Date(AT.getTime() + 2 * DAY);
    marks.now = () => clock;
    const verifier = new AnchorVerifierService(
      anchors as never,
      leaves as never,
      blockVersions as never,
      commentVersions as never,
      marks,
    );
    verifier.trustedRoots = [tsa.root];
    // The purge marks' leaf loads, by anchor.
    const loads: string[] = [];
    const findOne = anchors.findOne;
    anchors.findOne = (filter: unknown, ...rest: unknown[]) => {
      const query = (findOne as (...a: unknown[]) => unknown)(
        filter,
        ...rest,
      ) as { select: (s: Record<string, unknown>) => unknown };
      const select = query.select;
      query.select = (fields: Record<string, unknown>) => {
        if (fields.leaves === 1) {
          loads.push(String((filter as { _id?: unknown })._id));
        }
        return select(fields);
      };
      return query as never;
    };
    return { verifier, marks, loads, clock, versions, anchors };
  }

  it('a health report covering several suggester rows loads and verifies each anchor once', async () => {
    const { verifier, loads, clock } = report(3);
    const verify = jest.spyOn(rfc3161, 'verifyTimestampToken');
    const health = await verifier.verifyAll(clock);
    const page = (id: string) =>
      health.anchors.find((a) => a.anchorId === id)!.versions;
    expect(page('P')).toMatchObject({ outcome: 'cannot-measure' });
    expect(page('P').detail).toContain('1 had their personal content');
    expect(page('Q').detail).toContain('2 had their personal content');
    expect(loads.filter((id) => id === 'R')).toHaveLength(1);
    expect(loads.filter((id) => id === 'D')).toHaveLength(1);
    // Four anchors checked by the report itself, two by the purge marks.
    expect(verify).toHaveBeenCalledTimes(6);
    verify.mockRestore();
  });

  it('starts afresh for each report, and for each verifyAnchor', async () => {
    const { verifier, loads, clock, anchors } = report(2);
    await verifier.verifyAll(clock);
    await verifier.verifyAll(clock);
    expect(loads.filter((id) => id === 'R')).toHaveLength(2);
    const stored = anchors.docs.find((a) => a._id === 'P') as never;
    await verifier.verifyAnchor(stored);
    await verifier.verifyAnchor(stored);
    expect(loads.filter((id) => id === 'R')).toHaveLength(4);
  });

  it('keeps its checks across rows until the next request begins', async () => {
    const { marks, versions, loads } = report(1);
    marks.beginCheck();
    expect(await marks.classify('block', versions[0])).toBe('suggester');
    expect(await marks.classify('block', versions[0])).toBe('suggester');
    expect(loads.filter((id) => id === 'R')).toHaveLength(1);
    marks.beginCheck();
    expect(await marks.classify('block', versions[0])).toBe('suggester');
    expect(loads.filter((id) => id === 'R')).toHaveLength(2);
  });
});

describe('PurgeMarksService: round 9', () => {
  const MIN = 60_000;

  it('r9a F1: accepts a record up to five minutes after its anchor time (server clock fast)', async () => {
    expect(
      await marks({
        redactionSigned: new Date(AT.getTime() - 3 * MIN),
      }).classify('block', accepted),
    ).toBe('suggester');
    expect(
      await marks({
        redactionSigned: new Date(AT.getTime() - 6 * MIN),
      }).classify('block', accepted),
    ).toBe('invalid');
  });

  it('r9a race: a suggestion missing from the frozen list FAILS (the write gate keeps it off)', async () => {
    expect(
      await marks({ deletionIds: ['c-other'] }).classify('block', accepted),
    ).toBe('invalid');
  });

  it('r9b: an anchor unsigned past SWEEP_DAYS FAILS, and is accepted once FreeTSA signs it', async () => {
    const built = new Date(AT.getTime() + DAY);
    expect(
      await marks({
        redactionSigned: 'none',
        ownAnchor: { builtAt: built },
        clock: new Date(AT.getTime() + 32 * DAY),
      }).classify('block', accepted),
    ).toBe('invalid');
    expect(
      await marks({
        redactionSigned: new Date(AT.getTime() + 40 * DAY),
        ownAnchor: { builtAt: built },
        clock: new Date(AT.getTime() + 41 * DAY),
      }).classify('block', accepted),
    ).toBe('suggester');
  });
});

describe('PurgeMarksService and the anchor log (Chunk 16b)', () => {
  // The Chunk 17 residual: a full-database writer deletes the honest
  // anchor document outright and re-stamps a forged redaction with a fresh,
  // genuine FreeTSA token. Nothing left in the database contradicts the
  // forgery; only a copy of the log OUTSIDE the database can.
  const tampered = { ...accepted, text: 'Words the owner never accepted' };
  const honest = redactionRow(accepted, AT, ACCOUNT).hash;
  // As in round 7's r7b: a fresh stamp within the one-year margin.
  const FORGE = new Date(AT.getTime() + 200 * DAY);
  const forged = {
    version: tampered,
    history: [{ hash: honest, signed: new Date(AT.getTime() + DAY) }],
    redactionSigned: FORGE,
    clock: new Date(FORGE.getTime() + DAY),
    withLog: true,
  };

  /** Appends every anchor, signs, and publishes it, as the repository would. */
  async function published(service: PurgeMarksService) {
    const logged = logOf(service);
    await logged.log.append(new Date(FORGE.getTime() + DAY));
    logged.publishLatest();
    service.beginCheck();
  }

  it('the attack without the log: deleting the honest holder lets the forgery read as proven', async () => {
    const service = marks({ ...forged, withLog: false });
    // The honest holder (`hist-0`) is gone; the database is self-consistent.
    const anchors = (
      service as unknown as { anchorModel: { docs: Array<{ _id: string }> } }
    ).anchorModel;
    anchors.docs.splice(
      anchors.docs.findIndex((d) => d._id === 'hist-0'),
      1,
    );
    service.beginCheck();
    expect(await service.classify('block', tampered)).toBe('suggester');
  });

  it('FAILS the forgery once the honest holder was in the published log', async () => {
    const service = marks(forged);
    await published(service);
    // Before the deletion the forgery is already caught (Chunk 17 round 7).
    expect(await service.classify('block', tampered)).toBe('invalid');
    // The writer deletes the honest anchor document outright.
    const { anchors } = logOf(service);
    anchors.docs.splice(
      anchors.docs.findIndex((d) => d._id === '2031-10-10'),
      1,
    );
    service.beginCheck();
    expect(await service.classify('block', tampered)).toBe('invalid');
  });

  it('an honest purge reads as proven only once its anchors are in the published log', async () => {
    const service = marks({ withLog: true });
    // In this server's log, not published yet: pending, never proven.
    await logOf(service).log.append(new Date(AT.getTime() + 2 * DAY));
    service.beginCheck();
    expect(await service.classify('block', accepted)).toBe('suggester-pending');
    logOf(service).publishLatest();
    service.beginCheck();
    expect(await service.classify('block', accepted)).toBe('suggester');
  });

  it('cannot measure without a published log: pending, never proven', async () => {
    const service = marks({ withLog: true });
    const { log } = logOf(service);
    await log.append(new Date(AT.getTime() + 2 * DAY));
    logOf(service).publish({ ok: false, error: 'HTTP 503' });
    service.beginCheck();
    expect(await service.classify('block', accepted)).toBe('suggester-pending');
  });

  it('FAILS an honest-looking row when the log it was published in was rewritten', async () => {
    const service = marks({ withLog: true });
    await published(service);
    // Honest data; only the published head disagrees (a fork), so only the
    // log can see it.
    logOf(service).publish({
      ok: true,
      note: signNote(
        checkpointText(ANCHOR_LOG_ORIGIN, 3, Buffer.alloc(32, 5)),
        parseSigner(LOG_KEY.privateKey),
      ),
    });
    service.beginCheck();
    expect(await service.classify('block', accepted)).toBe('invalid');
  });
});

describe('PurgeMarksService: a second holder the log disowns (Chunk 16b)', () => {
  const honest = redactionRow(accepted, AT, ACCOUNT).hash;
  // Same hash, signed after the claimed anchor: round 7's rules accept it.
  const history = [
    { hash: honest, signed: new Date(AT.getTime() + 1.5 * DAY) },
  ];
  const clock = new Date(AT.getTime() + 4 * DAY);

  it('the control: without the log, such a holder is accepted', async () => {
    expect(await marks({ history, clock }).classify('block', accepted)).toBe(
      'suggester',
    );
  });

  it('FAILS a holder that no longer matches its own (unpublished) log entry', async () => {
    const service = marks({ history, clock, withLog: true });
    const logged = logOf(service);
    const { anchors, log } = logged;
    const at = anchors.docs.findIndex((d) => d._id === '2031-10-10');
    const [holder] = anchors.docs.splice(at, 1);
    await log.append(new Date(AT.getTime() + 3 * DAY));
    logged.publishLatest();
    // Appended after the publication: in the log's unpublished tail.
    anchors.docs.push(holder);
    await log.append(new Date(AT.getTime() + 3 * DAY));
    // A count the round 7 checks never read, but its log entry binds.
    holder.leafCount = 9;
    service.beginCheck();
    expect(await service.classify('block', accepted)).toBe('invalid');
  });
});

describe('PurgeMarksService: a deletion record whose anchor the log disowns (Chunk 16b)', () => {
  it('FAILS, where an unchecked day would only read pending', async () => {
    const service = marks({
      withLog: true,
      clock: new Date(AT.getTime() + 4 * DAY),
    });
    const logged = logOf(service);
    const { anchors, log } = logged;
    // The deletion record's anchor enters the log after the publication.
    const at = anchors.docs.findIndex((d) => d._id === '2026-11-15');
    const [deletionAnchor] = anchors.docs.splice(at, 1);
    await log.append(new Date(AT.getTime() + 3 * DAY));
    logged.publishLatest();
    anchors.docs.push(deletionAnchor);
    await log.append(new Date(AT.getTime() + 3 * DAY));
    // Then its row no longer gives its log entry (a count the other
    // checks never read).
    deletionAnchor.leafCount = 9;
    service.beginCheck();
    expect(await service.classify('block', accepted)).toBe('invalid');
  });
});

describe('PurgeMarksService: review 1, L3, a holder hidden by its versionId', () => {
  // The writer leaves the honest anchor in place (its status, root and
  // count still give its published log entry) but rewrites the versionId of
  // the redaction's entry in its leaves, keeping the leaf value, so no
  // lookup by version id finds it; then re-stamps a forged redaction.
  const tampered = { ...accepted, text: 'Words the owner never accepted' };
  const honest = redactionRow(accepted, AT, ACCOUNT).hash;
  const FORGE = new Date(AT.getTime() + 200 * DAY);

  it('L3: FAILS once the hidden holder was published', async () => {
    const service = marks({
      version: tampered,
      history: [{ hash: honest, signed: new Date(AT.getTime() + DAY) }],
      redactionSigned: FORGE,
      clock: new Date(FORGE.getTime() + DAY),
      withLog: true,
    });
    const logged = logOf(service);
    await logged.log.append(new Date(FORGE.getTime() + DAY));
    logged.publishLatest();
    const holder = logged.anchors.docs.find((d) => d._id === '2031-10-10')!;
    (holder.leaves as Array<{ versionId: unknown }>)[0].versionId =
      new Types.ObjectId();
    // Caught at the next leaf-set audit (review round 2, M2): this holder is
    // read by no check, so no per-request check can see it.
    await logged.log.refreshAudit();
    service.beginCheck();
    expect(await service.classify('block', tampered)).toBe('invalid');
  });
});

describe('PurgeMarksService: review 2, M2, the leaves a check reads are checked at once', () => {
  it('M2: a claimed anchor whose leaf list was rewritten after the audit FAILS without waiting for the next one', async () => {
    const service = marks({ withLog: true });
    const logged = logOf(service);
    await logged.log.append(new Date(AT.getTime() + 2 * DAY));
    logged.publishLatest();
    service.beginCheck();
    expect(await service.classify('block', accepted)).toBe('suggester');
    // The redaction's own anchor: one leaf's version id rewritten, root kept.
    const own = logged.anchors.docs.find((d) => d._id === '2031-11-15')!;
    (own.leaves as Array<{ versionId: unknown }>)[0].versionId =
      new Types.ObjectId();
    service.beginCheck();
    expect(await service.classify('block', accepted)).toBe('invalid');
  });
});
