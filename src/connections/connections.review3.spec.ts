// Review round 3 of Chunk 18: whatever state a pair is in when a block
// lands, the blocked member observes exactly what a matching non-block
// story would show them.
import { writeFileSync } from 'node:fs';
import { HttpException } from '@nestjs/common';
import { Types } from 'mongoose';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { MemberNotifier } from '../member-notifications/member-notifier.service';
import { NotificationPrefsService } from '../member-notifications/notification-prefs.service';
import { NotificationTargets } from '../member-notifications/notification-targets.service';
import { messagesFor } from './connection-messages';
import { pairKeyOf } from './connection-rules';
import { DEFAULT_TERMS } from './connection-terms.service';
import { harness, NOW, page } from './connections-harness.mocks-spec';

const M = messagesFor(DEFAULT_TERMS);
const DAY = 24 * 60 * 60_000;
const R = 'user_requester'; // the member who gets blocked
const T = 'user_target'; // the member who blocks

const ID = new Types.ObjectId('0123456789abcdef01234567');

type State =
  | 'no record'
  | 'R→T pending'
  | 'T→R pending'
  | 'connected'
  | 'R→T declined (<30 days)'
  | 'T→R declined'
  | 'R→T expired'
  | 'R→T stale, not yet swept'
  | 'T→R stale, not yet swept';

/** The non-block story each block state must look like, to R. */
const STORY: Record<State, 'nobody' | 'decline' | 'withdraw' | 'disconnect'> = {
  'no record': 'nobody',
  'R→T pending': 'decline',
  'T→R pending': 'withdraw',
  connected: 'disconnect',
  'R→T declined (<30 days)': 'nobody',
  'T→R declined': 'nobody',
  'R→T expired': 'nobody',
  'R→T stale, not yet swept': 'nobody',
  'T→R stale, not yet swept': 'nobody',
};

function seed(state: State) {
  const base = {
    _id: ID,
    pairKey: pairKeyOf(R, T),
    createdAt: new Date(NOW.getTime() - 2 * DAY),
  };
  switch (state) {
    case 'no record':
      return [];
    case 'R→T pending':
      return [
        { ...base, fromUserId: R, toUserId: T, status: 'pending', live: true },
      ];
    case 'T→R pending':
      return [
        { ...base, fromUserId: T, toUserId: R, status: 'pending', live: true },
      ];
    case 'connected':
      return [
        {
          ...base,
          fromUserId: R,
          toUserId: T,
          status: 'accepted',
          live: true,
          decidedAt: new Date(NOW.getTime() - DAY),
        },
      ];
    case 'R→T declined (<30 days)':
      return [
        {
          ...base,
          fromUserId: R,
          toUserId: T,
          status: 'declined',
          decidedAt: new Date(NOW.getTime() - DAY),
        },
      ];
    case 'T→R declined':
      return [
        {
          ...base,
          fromUserId: T,
          toUserId: R,
          status: 'declined',
          decidedAt: new Date(NOW.getTime() - DAY),
        },
      ];
    case 'R→T stale, not yet swept':
    case 'T→R stale, not yet swept': {
      const rToT = state.startsWith('R→T');
      return [
        {
          ...base,
          fromUserId: rToT ? R : T,
          toUserId: rToT ? T : R,
          status: 'pending',
          live: true,
          createdAt: new Date(NOW.getTime() - 100 * DAY),
        },
      ];
    }
    default:
      return [
        {
          ...base,
          fromUserId: R,
          toUserId: T,
          status: 'expired',
          endedAt: new Date(NOW.getTime() - DAY),
          createdAt: new Date(NOW.getTime() - 100 * DAY),
        },
      ];
  }
}

async function settle(promise: Promise<unknown>) {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      return { status: error.getStatus(), message: error.message };
    }
    throw error;
  }
}

/** Everything R can observe after T acts, in one object. */
async function observe(state: State, act: 'block' | 'story') {
  const h = harness({
    pages: [page(R, 'member-r'), page(T, 'member-t')],
    connections: seed(state),
  });
  const story = STORY[state];
  if (act === 'block') {
    await h.service.block(T, { slug: 'member-r' }, NOW);
  } else {
    if (story === 'decline') await h.service.decline(T, String(ID), NOW);
    if (story === 'withdraw') await h.service.withdraw(T, String(ID), NOW);
    if (story === 'disconnect') await h.service.disconnect(T, String(ID), NOW);
    await h.service.updateSettings(T, { openTo: 'nobody' }, NOW);
  }
  h.notifier.connectionRequested.mockClear();
  h.notifier.connectionAccepted.mockClear();
  const seen = {
    relation: await settle(h.views.relation(R, 'member-t', NOW)),
    overview: await h.views.overview(R, NOW),
    export: await h.records.exportFor(R, {
      kind: 'named-member',
      userId: R,
      isAdmin: false,
    }),
    oldId: {
      accept: await settle(h.service.accept(R, String(ID), NOW)),
      decline: await settle(h.service.decline(R, String(ID), NOW)),
      withdraw: await settle(h.service.withdraw(R, String(ID), NOW)),
      disconnect: await settle(h.service.disconnect(R, String(ID), NOW)),
    },
    send: await settle(h.service.send(R, 'member-t', undefined, NOW)),
  };
  // Emails R would get: any notice addressed to R from here on.
  const requested = h.notifier.connectionRequested.mock
    .calls as unknown as Array<[{ toUserId: string }]>;
  const accepted = h.notifier.connectionAccepted.mock.calls as unknown as Array<
    [{ fromUserId: string }]
  >;
  const emails = [
    ...requested.filter(([e]) => e.toUserId === R),
    ...accepted.filter(([e]) => e.fromUserId === R),
  ];
  // A new request's id is new in both runs; compare everything else.
  return JSON.parse(
    JSON.stringify({ ...seen, emails }).replace(
      /"id":"[0-9a-f]{24}"/g,
      '"id":"<new>"',
    ),
  ) as unknown;
}

describe('#1 a block ending R’s pending request reads as a decline to R', () => {
  it('R gets the 30-day wait, as after a decline', async () => {
    const h = harness({
      pages: [page(R, 'member-r'), page(T, 'member-t')],
      connections: seed('R→T pending'),
    });
    await h.service.block(T, { slug: 'member-r' }, NOW);
    await expect(h.views.relation(R, 'member-t', NOW)).resolves.toMatchObject({
      reason: 'cooldown',
    });
    expect(h.connections.docs[0]).toMatchObject({
      status: 'declined',
      decidedAt: NOW,
      endReason: 'block',
    });
  });
});

describe('#2 a block ending the blocker’s pending request reads as a withdrawal', () => {
  it('in the blocked recipient’s export', async () => {
    const h = harness({
      pages: [page(R, 'member-r'), page(T, 'member-t')],
      connections: seed('T→R pending'),
    });
    await h.service.block(T, { slug: 'member-r' }, NOW);
    const data = await h.records.exportFor(R, {
      kind: 'named-member',
      userId: R,
      isAdmin: false,
    });
    expect(data.requestsReceived[0]).toMatchObject({
      status: 'withdrawn',
      endedAt: NOW.toISOString(),
    });
  });
});

describe('#3 every state a block can land on', () => {
  it('looks to the blocked member exactly like its non-block story', async () => {
    const rows: string[] = [];
    const differ: string[] = [];
    for (const state of Object.keys(STORY) as State[]) {
      const blocked = JSON.stringify(await observe(state, 'block'));
      const story = JSON.stringify(await observe(state, 'story'));
      rows.push(
        `| ${state} | ${STORY[state] === 'nobody' ? '"open to nobody"' : `${STORY[state]} + "open to nobody"`} | ${blocked === story ? 'identical' : 'DIFFERS'} |`,
      );
      if (blocked !== story) differ.push(`${state}:\n${blocked}\n${story}`);
    }
    if (process.env.CONNECTIONS_SCENARIO_OUT) {
      writeFileSync(process.env.CONNECTIONS_SCENARIO_OUT, rows.join('\n'));
    }
    expect(differ).toEqual([]);
  });
});

describe('#4 a re-sent request the same day still gets its one email', () => {
  it('points the queued email at the live request', async () => {
    const queue = fakeModel([], { unique: [['dedupeKey']], timestamps: true });
    const notifier = new MemberNotifier(
      queue as never,
      new NotificationPrefsService(fakeModel([]) as never),
      { kick: jest.fn(() => Promise.resolve()) } as never,
    );
    const event = { fromUserId: R, toUserId: T, at: NOW };
    await notifier.connectionRequested({ ...event, connectionId: 'first' });
    await notifier.connectionRequested({ ...event, connectionId: 'second' });
    expect(queue.docs).toHaveLength(1);
    expect(queue.docs[0]).toMatchObject({ refs: { connectionId: 'second' } });
  });
});

describe('#5 send and the profile button follow one order', () => {
  it('for a member whose account is gone, during a decline wait', async () => {
    const h = harness({
      pages: [page(R, 'member-r'), page(T, 'member-t')],
      connections: seed('R→T declined (<30 days)'),
    });
    h.accounts.docs.push({ userId: T, at: NOW, purgeAfter: NOW });
    const relation = await h.views.relation(R, 'member-t', NOW);
    expect(relation).toMatchObject({ reason: 'cooldown' });
    await expect(
      settle(h.service.send(R, 'member-t', undefined, NOW)),
    ).resolves.toEqual({
      status: 403,
      message: M.cooldown(new Date(NOW.getTime() - DAY + 30 * DAY)),
    });
  });
});

describe('#5 send and the profile button agree on every combination', () => {
  it('including a target whose account is gone', async () => {
    const VIS = ['public', 'members', 'named-members', 'unlisted'] as const;
    const disagree: string[] = [];
    let checked = 0;
    for (const requester of VIS) {
      for (const target of VIS.slice(0, 3)) {
        for (const openTo of ['nobody', 'public-members', 'any-member']) {
          for (const cooldown of [false, true]) {
            for (const blocked of [false, true]) {
              for (const gone of [false, true]) {
                const h = harness({
                  pages: [
                    page(R, 'member-r', { visibility: requester }),
                    page(T, 'member-t', { visibility: target }),
                  ],
                  settings: [{ userId: T, openTo }],
                  connections: cooldown ? seed('R→T declined (<30 days)') : [],
                  blocks: blocked
                    ? [{ blockerUserId: T, blockedUserId: R }]
                    : [],
                });
                if (gone) {
                  h.accounts.docs.push({ userId: T, at: NOW, purgeAfter: NOW });
                }
                const relation = (await h.views.relation(
                  R,
                  'member-t',
                  NOW,
                )) as {
                  canRequest?: boolean;
                  reason?: string;
                  until?: string;
                };
                const sent = await settle(
                  h.service.send(R, 'member-t', undefined, NOW),
                );
                const expected = relation.canRequest
                  ? { status: 'pending' }
                  : {
                      status: 403,
                      message:
                        relation.reason === 'private-needs-public'
                          ? M.privateNeedsPublic
                          : relation.reason === 'cooldown'
                            ? M.cooldown(new Date(relation.until!))
                            : M.notOpen,
                    };
                checked += 1;
                if (
                  JSON.stringify(
                    'id' in (sent as object)
                      ? { status: (sent as { status: string }).status }
                      : sent,
                  ) !== JSON.stringify(expected)
                ) {
                  disagree.push(
                    `${requester}→${target} openTo ${openTo} cooldown ${cooldown} blocked ${blocked} gone ${gone}: ${JSON.stringify(sent)} vs ${JSON.stringify(relation)}`,
                  );
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(4 * 3 * 3 * 2 * 2 * 2);
    expect(disagree).toEqual([]);
  });
});

describe('#4 send, withdraw, send again the same day', () => {
  it('gives exactly one email, and it describes the live request', async () => {
    const queue = fakeModel([], { unique: [['dedupeKey']], timestamps: true });
    const notifier = new MemberNotifier(
      queue as never,
      new NotificationPrefsService(fakeModel([]) as never),
      { kick: jest.fn(() => Promise.resolve()) } as never,
    );
    const h = harness({
      pages: [page(R, 'member-r'), page(T, 'member-t')],
      notifier,
    });
    const first = await h.service.send(R, 'member-t', undefined, NOW);
    await h.service.withdraw(R, first.id, NOW);
    const second = await h.service.send(R, 'member-t', undefined, NOW);
    expect(queue.docs).toHaveLength(1);
    const targets = new NotificationTargets(
      {} as never,
      h.profiles as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      h.connections as never,
      fakeModel([]) as never,
    );
    const row = queue.docs[0] as {
      kind: string;
      refs: { connectionId: string };
    };
    expect(row.refs.connectionId).toBe(second.id);
    await expect(
      targets.describe(
        {
          kind: 'connection-requested',
          refs: { connectionId: new Types.ObjectId(row.refs.connectionId) },
        } as never,
        {
          userId: T,
          isAdmin: false,
          viewer: { kind: 'named-member', userId: T, isAdmin: false },
        },
      ),
    ).resolves.toMatchObject({ kind: 'connection-requested' });
  });
});
