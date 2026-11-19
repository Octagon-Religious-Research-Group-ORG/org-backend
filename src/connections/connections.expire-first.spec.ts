// Expire before act (review rounds 4 and 5): every entry point that reads
// or writes connection rows takes `ConnectionRecords.fresh` FIRST, for
// exactly the rows it touches. For every public method, and for every
// function-valued instance field, this runs the method on a stale, unswept
// request in each direction, with a second, unrelated stale pair beside it,
// and checks:
// - the method's own answer is the one it gives once the request expired
//   (so expiring AFTER acting fails);
// - the request is expired (so a scope that is too narrow fails);
// - the unrelated pair is NOT (so a scope that is too wide fails).
// Every method is either checked or exempt, per class, with its reason.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ConnectionLookups } from './connection-lookups.service';
import { ConnectionRecords } from './connection-records.service';
import { pairKeyOf } from './connection-rules';
import { ConnectionViews } from './connection-views.service';
import { ConnectionsService } from './connections.service';
import { harness, NOW, page } from './connections-harness.mocks-spec';

const DAY = 24 * 60 * 60_000;
const R = 'user_requester';
const T = 'user_target';
const X = 'user_unrelated_x';
const Y = 'user_unrelated_y';
const STALE = new Types.ObjectId('0123456789abcdef01234567');
const OTHER = new Types.ObjectId('0123456789abcdef01234568');
const ID = String(STALE);
const READER = { kind: 'named-member' as const, userId: R, isAdmin: false };

type Dir = 'R→T' | 'T→R';
type H = ReturnType<typeof harness>;

function build(dir: Dir) {
  const old = new Date(NOW.getTime() - 100 * DAY);
  const [from, to] = dir === 'R→T' ? [R, T] : [T, R];
  return harness({
    pages: [
      page(R, 'member-r'),
      page(T, 'member-t'),
      page(X, 'member-x'),
      page(Y, 'member-y'),
    ],
    connections: [
      {
        _id: STALE,
        fromUserId: from,
        toUserId: to,
        pairKey: pairKeyOf(R, T),
        status: 'pending',
        live: true,
        note: 'Synthetic old note',
        createdAt: old,
      },
      {
        _id: OTHER,
        fromUserId: X,
        toUserId: Y,
        pairKey: pairKeyOf(X, Y),
        status: 'pending',
        live: true,
        createdAt: old,
      },
    ],
  });
}

async function settle(promise: Promise<unknown>) {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof HttpException) return { status: error.getStatus() };
    throw error;
  }
}

/** The member who received the stale request, and who sent it. */
const recipient = (dir: Dir) => (dir === 'R→T' ? T : R);
const sender = (dir: Dir) => (dir === 'R→T' ? R : T);

interface Check {
  call: (h: H, dir: Dir) => Promise<unknown>;
  /** The answer the method gives only if it saw the request expired. */
  sees?: (result: unknown, dir: Dir) => void;
}

const notFound = (result: unknown) => expect(result).toEqual({ status: 404 });

const CHECKS: Record<string, Record<string, Check>> = {
  ConnectionsService: {
    send: {
      call: (h) => h.service.send(R, 'member-t', undefined, NOW),
      // Not "already sent", and not a crossing that accepts the old one.
      sees: (result) => expect(result).toMatchObject({ status: 'pending' }),
    },
    accept: {
      call: (h, dir) => h.service.accept(recipient(dir), ID, NOW),
      sees: notFound,
    },
    decline: {
      call: (h, dir) => h.service.decline(recipient(dir), ID, NOW),
      sees: notFound,
    },
    withdraw: {
      call: (h, dir) => h.service.withdraw(sender(dir), ID, NOW),
      sees: notFound,
    },
    disconnect: { call: (h) => h.service.disconnect(R, ID, NOW) },
    block: { call: (h) => h.service.block(T, { slug: 'member-r' }, NOW) },
    unblock: { call: (h) => h.service.unblock(R, ID, NOW) },
    updateSettings: {
      call: (h) => h.service.updateSettings(R, { openTo: 'nobody' }, NOW),
    },
  },
  ConnectionViews: {
    relation: {
      call: (h) => h.views.relation(R, 'member-t', NOW),
      sees: (result) => expect(result).toMatchObject({ state: 'none' }),
    },
    overview: {
      call: (h) => h.views.overview(R, NOW),
      sees: (result) =>
        expect(result).toMatchObject({ incoming: [], outgoing: [] }),
    },
  },
  ConnectionRecords: {
    endAllFor: { call: (h) => h.records.endAllFor(R, NOW) },
    exportFor: {
      call: (h) => h.records.exportFor(R, READER, NOW),
      sees: (result) => expect(JSON.stringify(result)).not.toContain('pending'),
    },
    noteTarget: {
      call: (h, dir) => h.records.noteTarget(recipient(dir), ID, NOW),
    },
    noteViews: {
      call: (h) => h.records.noteViews([ID], NOW),
      sees: (result) =>
        expect(
          (result as Map<string, { status: string }>).get(ID)?.status,
        ).toBe('expired'),
    },
    senderOf: { call: (h) => h.records.senderOf(ID, undefined, NOW) },
    hideNote: { call: (h) => h.records.hideNote(ID, NOW, {} as never) },
  },
  ConnectionLookups: {},
};

/** Per class: what is not an entry point, and why. */
const EXEMPT: Record<string, Record<string, string>> = {
  ConnectionsService: {
    gate: 'private: writes a gate row, reads no connection row',
    whileBothCount:
      'private: the transaction wrapper; its callers (send, markAccepted) act after fresh',
    refuse: 'private: throws an answer, touches nothing',
    answerLive: 'private: runs inside send, after its fresh()',
    stillAllowed: 'private: runs inside accept or send, after their fresh()',
    markAccepted: 'private: runs inside accept or send, after their fresh()',
    ownRow: 'private: runs inside the answers, after their fresh()',
    expireMine: 'private: IS the answers’ fresh() call',
    close: 'private: runs inside the answers, after their fresh()',
  },
  ConnectionViews: {},
  ConnectionRecords: {
    pagesOf: 'reads pages only, never a connection row',
    card: 'pure: names a member from a page already read',
    expireStale: 'is the expiry itself',
    fresh: 'is the expiry itself',
    purgeForPage: 'deletes every row of the member outright',
    purgeForAccount: 'deletes every row of the person outright',
  },
  // A helper, never an entry point: no controller or other module uses it
  // (asserted below), and the three classes above call it only after their
  // own fresh().
  ConnectionLookups: Object.fromEntries(
    [
      'words',
      'member',
      'stillCounts',
      'viewerOf',
      'findPage',
      'pageAt',
      'openToOf',
      'blockedEitherWay',
      'live',
      'cooldownUntil',
      'pendingSent',
      'eligibleAmong',
      'fresh',
      'liveWith',
      'refusalOf',
      'sharedContacts',
      'mySettings',
    ].map((name) => [
      name,
      'helper, called only after an entry point’s fresh()',
    ]),
  ),
};

/** Every method on the prototype, and every function-valued own field. */
function methodsOf(instance: object) {
  const proto = Object.getPrototypeOf(instance) as object;
  const onProto = Object.getOwnPropertyNames(proto).filter(
    (name) => name !== 'constructor',
  );
  const fields = Object.keys(instance).filter(
    (name) => typeof (instance as Record<string, unknown>)[name] === 'function',
  );
  return [...onProto, ...fields];
}

describe('expire before act', () => {
  it('checks or exempts, with a reason, every method of every class', () => {
    const h = build('R→T');
    const instances: Record<string, object> = {
      ConnectionsService: h.service,
      ConnectionViews: h.views,
      ConnectionRecords: h.records,
      ConnectionLookups: h.lookups,
    };
    for (const [name, instance] of Object.entries(instances)) {
      const known = [
        ...Object.keys(CHECKS[name]),
        ...Object.keys(EXEMPT[name]),
      ];
      const unknown = methodsOf(instance).filter((m) => !known.includes(m));
      expect([name, unknown]).toEqual([name, []]);
    }
    // The classes are what this test says they are.
    expect(h.service).toBeInstanceOf(ConnectionsService);
    expect(h.views).toBeInstanceOf(ConnectionViews);
    expect(h.records).toBeInstanceOf(ConnectionRecords);
    expect(h.lookups).toBeInstanceOf(ConnectionLookups);
  });

  it('ConnectionLookups is used by the three connection classes only', () => {
    const root = join(__dirname, '..');
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return files(path);
        return /\.ts$/.test(entry) && !/spec\.ts$/.test(entry) ? [path] : [];
      });
    const users = files(root)
      .filter((path) =>
        readFileSync(path, 'utf8').includes('ConnectionLookups'),
      )
      .map((path) => path.slice(root.length + 1).replace(/\\/g, '/'))
      .sort();
    expect(users).toEqual([
      'connections/connection-lookups.service.ts',
      'connections/connection-views.service.ts',
      'connections/connections.module.ts',
      'connections/connections.service.ts',
    ]);
  });

  for (const [name, checks] of Object.entries(CHECKS)) {
    for (const [method, check] of Object.entries(checks)) {
      for (const dir of ['R→T', 'T→R'] as const) {
        it(`${name}.${method} (${dir}) acts on the request as expired, and only on its own rows`, async () => {
          const h = build(dir);
          const result = await settle(check.call(h, dir));
          check.sees?.(result, dir);
          const byId = (id: Types.ObjectId) =>
            h.connections.docs.find((doc) => String(doc._id) === String(id));
          expect(byId(STALE)).toMatchObject({ status: 'expired' });
          expect(byId(OTHER)).toMatchObject({ status: 'pending', live: true });
        });
      }
    }
  }
});

describe('the send’s in-transaction check (review round 5)', () => {
  it('counts a page from before the review field as approved', async () => {
    const h = harness({
      pages: [
        page(R, 'member-r'),
        page(T, 'member-t', { reviewStatus: undefined }),
      ],
    });
    await expect(
      h.service.send(R, 'member-t', undefined, NOW),
    ).resolves.toMatchObject({ status: 'pending' });
  });
});
