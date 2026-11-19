// Emails about connection requests (Chunk 18): queued for the right member,
// at most once a day per pair, never with the note, and dropped when the
// request no longer stands by the time the email goes out.
import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { MemberNotifier } from './member-notifier.service';
import { composeEmail, scopeWords } from './notification-mail';
import { NotificationPrefsService } from './notification-prefs.service';
import {
  CONNECTIONS_PATH,
  NotificationTargets,
  type Recipient,
} from './notification-targets.service';

const AT = new Date('2026-11-19T12:00:00Z');

function notifier(prefs: Array<Record<string, unknown>> = []) {
  const queue = fakeModel([], { unique: [['dedupeKey']], timestamps: true });
  const service = new MemberNotifier(
    queue as never,
    new NotificationPrefsService(fakeModel(prefs) as never),
    { kick: jest.fn(() => Promise.resolve()) } as never,
  );
  return { queue, service };
}

describe('MemberNotifier: connection requests', () => {
  it('tells the recipient of a new request once a day per pair, by digest', async () => {
    const { queue, service } = notifier();
    const event = {
      connectionId: 'c1',
      fromUserId: 'user_a',
      toUserId: 'user_b',
      at: AT,
    };
    await service.connectionRequested(event);
    await service.connectionRequested({ ...event, connectionId: 'c2' });
    await service.connectionRequested({
      ...event,
      connectionId: 'c3',
      at: new Date('2026-11-20T00:00:01Z'),
    });
    expect(queue.docs.map((d) => [d.userId, d.kind, d.delivery])).toEqual([
      ['user_b', 'connection-requested', 'digest'],
      ['user_b', 'connection-requested', 'digest'],
    ]);
    expect(queue.docs[0]).toMatchObject({
      category: 'connectionRequests',
      // The day's one email now points at the latest request (round 3).
      actorUserId: 'user_a',
      refs: { connectionId: 'c2' },
    });
    expect(JSON.stringify(queue.docs)).not.toContain('note');
  });

  it('tells the sender once that their request was accepted', async () => {
    const { queue, service } = notifier();
    const event = {
      connectionId: 'c1',
      fromUserId: 'user_a',
      acceptedBy: 'user_b',
      at: AT,
    };
    await service.connectionAccepted(event);
    await service.connectionAccepted(event);
    expect(queue.docs.map((d) => [d.userId, d.kind, d.category])).toEqual([
      ['user_a', 'connection-accepted', 'connectionAccepts'],
    ]);
  });

  it('honours each opt-out', async () => {
    const { queue, service } = notifier([
      { userId: 'user_b', off: ['connectionRequests'] },
      { userId: 'user_a', off: ['connectionAccepts'] },
    ]);
    await service.connectionRequested({
      connectionId: 'c1',
      fromUserId: 'user_a',
      toUserId: 'user_b',
      at: AT,
    });
    await service.connectionAccepted({
      connectionId: 'c1',
      fromUserId: 'user_a',
      acceptedBy: 'user_b',
      at: AT,
    });
    expect(queue.docs).toHaveLength(0);
  });
});

/** Both members of these rows still have their pages. */
const PAIR = { fromUserId: 'user_a', toUserId: 'user_b' };
const PAGES = [{ ownerUserId: 'user_a' }, { ownerUserId: 'user_b' }];

describe('NotificationTargets: connection requests', () => {
  const reader: Recipient = {
    userId: 'user_b',
    isAdmin: false,
    viewer: { kind: 'named-member', userId: 'user_b', isAdmin: false },
  };

  function targets(rows: Array<Record<string, unknown>>) {
    return new NotificationTargets(
      {} as never,
      fakeModel(PAGES) as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      fakeModel(rows) as never,
      fakeModel([]) as never,
    );
  }

  const ask = (
    t: NotificationTargets,
    kind: 'connection-requested' | 'connection-accepted',
    connectionId?: Types.ObjectId,
  ) =>
    t.describe(
      {
        kind,
        refs: (connectionId ? { connectionId } : {}) as never,
      },
      reader,
    );

  it('links to the connections page while the request still stands', async () => {
    const pending = new Types.ObjectId();
    const accepted = new Types.ObjectId();
    const t = targets([
      { _id: pending, status: 'pending', live: true, ...PAIR },
      { _id: accepted, status: 'accepted', live: true, ...PAIR },
    ]);
    const terms = {
      singular: 'connection request',
      plural: 'connection requests',
    };
    await expect(ask(t, 'connection-requested', pending)).resolves.toEqual({
      kind: 'connection-requested',
      path: CONNECTIONS_PATH,
      terms,
    });
    await expect(ask(t, 'connection-accepted', accepted)).resolves.toEqual({
      kind: 'connection-accepted',
      path: CONNECTIONS_PATH,
      terms,
    });
  });

  it('drops one withdrawn, declined, ended or missing before it was sent', async () => {
    const ended = new Types.ObjectId();
    const accepted = new Types.ObjectId();
    const t = targets([
      { _id: ended, status: 'withdrawn' },
      { _id: accepted, status: 'accepted', live: true },
    ]);
    await expect(
      ask(t, 'connection-requested', ended),
    ).resolves.toBeUndefined();
    await expect(
      ask(t, 'connection-requested', accepted),
    ).resolves.toBeUndefined();
    await expect(
      ask(t, 'connection-accepted', new Types.ObjectId()),
    ).resolves.toBeUndefined();
    await expect(ask(t, 'connection-accepted')).resolves.toBeUndefined();
  });
});

describe('connection emails use the admins’ name (review round 1, #6)', () => {
  const RENAMED = JSON.stringify({
    singular: 'introduction',
    plural: 'introductions',
  });

  it('carries the name from the setting when the email is described', async () => {
    const pending = new Types.ObjectId();
    const targets = new NotificationTargets(
      {} as never,
      fakeModel(PAGES) as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      fakeModel([
        { _id: pending, status: 'pending', live: true, ...PAIR },
      ]) as never,
      fakeModel([{ key: 'connection-name', value: RENAMED }]) as never,
    );
    await expect(
      targets.describe(
        {
          kind: 'connection-requested',
          refs: { connectionId: pending } as never,
        },
        {
          userId: 'user_b',
          isAdmin: false,
          viewer: { kind: 'named-member', userId: 'user_b', isAdmin: false },
        },
      ),
    ).resolves.toEqual({
      kind: 'connection-requested',
      path: CONNECTIONS_PATH,
      terms: { singular: 'introduction', plural: 'introductions' },
    });
  });

  it('writes the lines, subject and unsubscribe words in that name', () => {
    const terms = { singular: 'introduction', plural: 'introductions' };
    const base = {
      userId: 'user_b',
      signingKey: Buffer.from('k'.repeat(32)),
      publicAppUrl: 'https://org.example.test',
    };
    const one = composeEmail({
      ...base,
      digest: false,
      scope: 'connectionRequests',
      items: [{ kind: 'connection-requested', path: '/x', terms }],
    });
    expect(one.subject).toBe('A member sent you an introduction');
    expect(one.lines).toContain('- A member sent you an introduction.');
    expect(one.lines.join('\n')).toContain(
      'Turn off emails about new introductions:',
    );
    const many = composeEmail({
      ...base,
      digest: true,
      scope: 'digest',
      items: [
        { kind: 'connection-accepted', path: '/x', terms },
        { kind: 'connection-accepted', path: '/x', terms },
      ],
    });
    expect(many.lines).toContain('- Members accepted 2 of your introductions.');
    expect(scopeWords('connectionAccepts', terms)).toBe(
      'emails about accepted introductions',
    );
    // Without a name, the default words.
    expect(scopeWords('connectionAccepts')).toBe(
      'emails about accepted connection requests',
    );
  });
});

describe('repointing the waiting email (review round 3)', () => {
  it('logs, and never fails the request, when the update cannot be written', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const queue = fakeModel([], {
      unique: [['dedupeKey']],
      beforeWrite: (operation) => {
        if (operation === 'updateOne') throw new Error('queue down');
      },
    });
    const service = new MemberNotifier(
      queue as never,
      new NotificationPrefsService(fakeModel([]) as never),
      { kick: jest.fn(() => Promise.resolve()) } as never,
    );
    const event = { fromUserId: 'user_a', toUserId: 'user_b', at: AT };
    await service.connectionRequested({ ...event, connectionId: 'c1' });
    await expect(
      service.connectionRequested({ ...event, connectionId: 'c2' }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not update a queued notification'),
    );
    warn.mockRestore();
  });
});
