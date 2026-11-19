// Review round 2 of Chunk 18: a block must never change any answer a
// requester can see, and the send's duplicate-key handling is narrowed to
// the pair index.
import { writeFileSync } from 'node:fs';
import { HttpException } from '@nestjs/common';
import { Types } from 'mongoose';
import { messagesFor } from './connection-messages';
import { pairKeyOf, requestRefusal } from './connection-rules';
import { DEFAULT_TERMS } from './connection-terms.service';
import { harness, NOW, page } from './connections-harness.mocks-spec';
import { MemberConnectionSchema } from './schemas/connection.schema';

const M = messagesFor(DEFAULT_TERMS);
const DAY = 24 * 60 * 60_000;
const R = 'user_requester';
const T = 'user_target';

const VISIBILITIES = [
  'public',
  'members',
  'named-members',
  'unlisted',
] as const;
const OPEN_TO = ['nobody', 'public-members', 'any-member'] as const;
type Block = 'none' | 'by-target' | 'by-requester';

/** What the requester sees: the send's answer and the profile button's. */
async function answers(c: {
  requester: (typeof VISIBILITIES)[number];
  anonymous: boolean;
  target: (typeof VISIBILITIES)[number];
  openTo: (typeof OPEN_TO)[number];
  cooldown: boolean;
  block: Block;
}) {
  const h = harness({
    pages: [
      page(R, 'member-r', {
        visibility: c.requester,
        anonymous: c.anonymous,
      }),
      page(T, 'member-t', { visibility: c.target }),
    ],
    settings: [{ userId: T, openTo: c.openTo }],
    connections: c.cooldown
      ? [
          {
            _id: new Types.ObjectId(),
            fromUserId: R,
            toUserId: T,
            pairKey: pairKeyOf(R, T),
            status: 'declined',
            decidedAt: new Date(NOW.getTime() - DAY),
            createdAt: new Date(NOW.getTime() - 2 * DAY),
          },
        ]
      : [],
    blocks:
      c.block === 'by-target'
        ? [{ blockerUserId: T, blockedUserId: R }]
        : c.block === 'by-requester'
          ? [{ blockerUserId: R, blockedUserId: T }]
          : [],
  });
  const settle = async (promise: Promise<unknown>) => {
    try {
      const value = (await promise) as { status?: string; state?: string };
      return value.state === 'blocked' ? 'blocked (own)' : value;
    } catch (error) {
      if (error instanceof HttpException) {
        return { status: error.getStatus(), message: error.message };
      }
      throw error;
    }
  };
  return {
    send: await settle(h.service.send(R, 'member-t', undefined, NOW)),
    relation: await settle(h.views.relation(R, 'member-t', NOW)),
  };
}

describe('#1 a Private requester is told the Private rule first', () => {
  it('whether or not the target blocked them', () => {
    const base = {
      requester: { userId: R, visibility: 'unlisted' as const, eligible: true },
      target: { userId: T, visibility: 'members' as const, eligible: true },
      targetOpenTo: 'any-member' as const,
    };
    expect(requestRefusal({ ...base, blocked: false })).toBe(
      'private-needs-public',
    );
    expect(requestRefusal({ ...base, blocked: true })).toBe(
      'private-needs-public',
    );
  });
});

describe('#1/#2 a block is indistinguishable from "open to nobody"', () => {
  it('for every requester × target visibility × open-to × cooldown × block either way', async () => {
    const table: string[] = [];
    const mismatches: string[] = [];
    for (const requester of VISIBILITIES) {
      for (const anonymous of [false, true]) {
        for (const target of VISIBILITIES) {
          for (const cooldown of [false, true]) {
            const nobody = await answers({
              requester,
              anonymous,
              target,
              openTo: 'nobody',
              cooldown,
              block: 'none',
            });
            for (const openTo of OPEN_TO) {
              for (const block of ['by-target', 'by-requester'] as const) {
                const got = await answers({
                  requester,
                  anonymous,
                  target,
                  openTo,
                  cooldown,
                  block,
                });
                // The requester's own block shows as such on the button
                // (they made it); only the SEND must look like "nobody".
                const same =
                  JSON.stringify(got.send) === JSON.stringify(nobody.send) &&
                  (block === 'by-requester' ||
                    JSON.stringify(got.relation) ===
                      JSON.stringify(nobody.relation));
                if (!same) {
                  mismatches.push(
                    `${requester}${anonymous ? '/anon' : ''} → ${target}, openTo ${openTo}, cooldown ${cooldown}, ${block}: ${JSON.stringify(got)} vs ${JSON.stringify(nobody)}`,
                  );
                }
              }
            }
            table.push(
              `| ${requester}${anonymous ? ' (anon)' : ''} | ${target} | ${cooldown ? 'yes' : 'no'} | ${JSON.stringify(nobody.send)} | ${JSON.stringify(nobody.relation)} |`,
            );
          }
        }
      }
    }
    if (process.env.CONNECTIONS_TABLE_OUT) {
      writeFileSync(process.env.CONNECTIONS_TABLE_OUT, table.join('\n'));
    }
    expect(mismatches).toEqual([]);
  });
});

describe('#2 the decline wait outranks a later block', () => {
  it('a declined-then-blocked sender still sees the 30-day message', async () => {
    const got = await answers({
      requester: 'public',
      anonymous: false,
      target: 'public',
      openTo: 'any-member',
      cooldown: true,
      block: 'by-target',
    });
    expect(got.send).toEqual({
      status: 403,
      message: M.cooldown(new Date(NOW.getTime() - DAY + 30 * DAY)),
    });
    expect(got.relation).toMatchObject({ reason: 'cooldown' });
  });
});

describe('#3 only a pair collision counts as a crossing', () => {
  it('rethrows a duplicate key on any other index', async () => {
    const other = Object.assign(new Error('E11000 duplicate key'), {
      code: 11000,
      keyPattern: { userId: 1 },
    });
    const h = harness({
      beforeConnectionWrite: (operation) => {
        if (operation === 'create') throw other;
      },
    });
    await expect(
      h.service.send('user_a', 'member-b', undefined, NOW),
    ).rejects.toBe(other);
  });
});

describe('#4 the expiry sweep has an index', () => {
  it('a partial index on createdAt for live pending requests', () => {
    expect(MemberConnectionSchema.indexes()).toContainEqual([
      { createdAt: 1 },
      expect.objectContaining({
        partialFilterExpression: { live: true, status: 'pending' },
      }),
    ]);
  });
});

describe('#3 anything thrown that is not a pair collision', () => {
  it('is passed on as it is', async () => {
    const h = harness({
      beforeConnectionWrite: (operation) => {
        // A driver can throw anything.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        if (operation === 'create') throw 'not an object';
      },
    });
    await expect(
      h.service.send('user_a', 'member-b', undefined, NOW),
    ).rejects.toBe('not an object');
  });
});

describe('#1 the Private rule first, also for a page with no member who counts', () => {
  it('for an unclaimed page and for a member whose account is gone', async () => {
    const h = harness({
      pages: [
        page(R, 'member-r', { visibility: 'unlisted' }),
        page('', 'unclaimed-page', {
          ownerUserId: undefined,
          visibility: 'members',
        }),
        page('user_h', 'gone-member', { visibility: 'members' }),
      ],
    });
    h.accounts.docs.push({ userId: 'user_h', at: NOW, purgeAfter: NOW });
    for (const slug of ['unclaimed-page', 'gone-member']) {
      await expect(
        h.service.send(R, slug, undefined, NOW),
      ).rejects.toMatchObject({ message: M.privateNeedsPublic });
    }
    await expect(
      h.views.relation(R, 'unclaimed-page', NOW),
    ).resolves.toMatchObject({ reason: 'private-needs-public' });
  });
});
