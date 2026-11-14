import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { MemberNotifier } from './member-notifier.service';
import { NotificationPrefsService } from './notification-prefs.service';

const PAGE = new Types.ObjectId();

function build(options: { prefs?: Record<string, unknown>[] } = {}) {
  let fail: unknown;
  const queue = fakeModel([], {
    unique: [['dedupeKey']],
    timestamps: true,
    beforeWrite: () => {
      if (fail) throw fail as Error;
    },
  });
  const prefsModel = fakeModel(options.prefs ?? [], { unique: [['userId']] });
  const dispatcher = { kick: jest.fn(() => Promise.resolve()) };
  const notifier = new MemberNotifier(
    queue as never,
    new NotificationPrefsService(prefsModel as never),
    dispatcher as never,
  );
  return {
    queue,
    dispatcher,
    notifier,
    failWith: (error: unknown) => {
      fail = error;
    },
  };
}

const rows = (queue: ReturnType<typeof fakeModel>) =>
  queue.docs.map((d) => [d.userId, d.kind, d.delivery]);

describe('MemberNotifier (Chunk 14)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => warn.mockRestore());

  it('tells the page owner of a comment and the answered author of a reply, never the writer', async () => {
    const { queue, notifier, dispatcher } = build();
    await notifier.commentPosted({
      commentId: 'c1',
      actorUserId: 'user_writer',
      profileId: PAGE,
      tabId: 'tab_a',
      pageOwnerUserId: 'user_owner',
    });
    await notifier.commentPosted({
      commentId: 'c2',
      actorUserId: 'user_writer',
      profileId: PAGE,
      pageOwnerUserId: 'user_owner',
      parentAuthorUserId: 'user_parent',
    });
    // The owner answered: told once, as a reply.
    await notifier.commentPosted({
      commentId: 'c3',
      actorUserId: 'user_writer',
      profileId: PAGE,
      pageOwnerUserId: 'user_owner',
      parentAuthorUserId: 'user_owner',
    });
    // Own comment on own page, own reply to own comment: nothing.
    await notifier.commentPosted({
      commentId: 'c4',
      actorUserId: 'user_owner',
      profileId: PAGE,
      pageOwnerUserId: 'user_owner',
      parentAuthorUserId: 'user_owner',
    });
    // An ORG page has no owner; an imported author has no account.
    await notifier.commentPosted({
      commentId: 'c5',
      actorUserId: 'user_writer',
      profileId: PAGE,
      parentAuthorUserId: 'imported:cmt_x',
    });
    expect(rows(queue)).toEqual([
      ['user_owner', 'comment-on-page', 'digest'],
      ['user_parent', 'reply', 'digest'],
      ['user_owner', 'comment-on-page', 'digest'],
      ['user_owner', 'reply', 'digest'],
    ]);
    expect(queue.docs[0]).toMatchObject({
      category: 'comments',
      status: 'queued',
      actorUserId: 'user_writer',
      refs: { commentId: 'c1', profileId: PAGE, tabId: 'tab_a' },
      dedupeKey: 'comment-on-page:c1:user_owner',
      attempts: 0,
    });
    expect(queue.docs[1].refs).toEqual({ commentId: 'c2', profileId: PAGE });
    // Nothing queued for later wakes the sender.
    expect(dispatcher.kick).not.toHaveBeenCalled();
  });

  it('queues each event once per reader', async () => {
    const { queue, notifier } = build();
    const event = {
      commentId: 'c1',
      actorUserId: 'user_writer',
      profileId: PAGE,
      pageOwnerUserId: 'user_owner',
    };
    await notifier.commentPosted(event);
    await notifier.commentPosted(event);
    expect(queue.docs).toHaveLength(1);
  });

  it('tells suggestions and their decisions, once each', async () => {
    const { queue, notifier } = build();
    await notifier.suggestionPosted({
      commentId: 's1',
      actorUserId: 'user_writer',
      ownerUserId: 'user_owner',
    });
    await notifier.suggestionPosted({
      commentId: 's2',
      actorUserId: 'user_writer',
    });
    await notifier.suggestionDecided({
      commentId: 's1',
      actorUserId: 'user_owner',
      suggesterUserId: 'user_writer',
    });
    await notifier.suggestionDecided({
      commentId: 's1',
      actorUserId: 'user_owner',
      suggesterUserId: 'user_writer',
    });
    await notifier.suggestionDecided({ commentId: 's9', actorUserId: 'u' });
    expect(rows(queue)).toEqual([
      ['user_owner', 'suggestion-posted', 'digest'],
      ['user_writer', 'suggestion-decided', 'digest'],
    ]);
  });

  it('tells an owner a wording reached the agreed list once per wording', async () => {
    const { queue, notifier } = build();
    const event = {
      profileId: PAGE,
      tabId: 'tab_a',
      textSeq: 2,
      ownerUserId: 'user_owner',
      actorUserId: 'user_voter',
    };
    await notifier.beliefAgreed(event);
    await notifier.beliefAgreed(event);
    await notifier.beliefAgreed({ ...event, textSeq: 3 });
    await notifier.beliefAgreed({ ...event, ownerUserId: undefined });
    expect(queue.docs.map((d) => d.dedupeKey)).toEqual([
      'belief-agreed:tab_a:2',
      'belief-agreed:tab_a:3',
    ]);
  });

  it('sends claim and moderation news at once, and wakes the sender', async () => {
    const { queue, notifier, dispatcher } = build();
    await notifier.claimDecided({
      claimId: 'k1',
      claimantUserId: 'user_c',
      actorUserId: 'user_admin',
      profileId: PAGE,
      approved: true,
    });
    await notifier.claimDecided({
      claimId: 'k2',
      claimantUserId: 'user_c',
      actorUserId: 'user_admin',
      profileId: PAGE,
      approved: false,
    });
    for (const state of ['hidden', 'removed', null] as const) {
      await notifier.commentModerated({
        commentId: 'c1',
        authorUserId: 'user_author',
        actorUserId: 'user_admin',
        state,
      });
    }
    await notifier.commentModerated({
      commentId: 'c2',
      actorUserId: 'user_admin',
      state: 'hidden',
    });
    expect(rows(queue)).toEqual([
      ['user_c', 'claim-approved', 'immediate'],
      ['user_c', 'claim-rejected', 'immediate'],
      ['user_author', 'comment-hidden', 'immediate'],
      ['user_author', 'comment-removed', 'immediate'],
      ['user_author', 'comment-restored', 'immediate'],
    ]);
    expect(dispatcher.kick).toHaveBeenCalledTimes(5);
  });

  it('follows the reader’s settings: digest instead, or nothing', async () => {
    const { queue, notifier } = build({
      prefs: [
        { userId: 'user_quiet', off: [], immediate: false, digest: true },
        { userId: 'user_none', off: ['moderation'], digest: true },
      ],
    });
    for (const authorUserId of ['user_quiet', 'user_none']) {
      await notifier.commentModerated({
        commentId: 'c1',
        authorUserId,
        actorUserId: 'user_admin',
        state: 'hidden',
      });
    }
    expect(rows(queue)).toEqual([['user_quiet', 'comment-hidden', 'digest']]);
  });

  it('queues one admin notice for all admins, once per key', async () => {
    const { queue, notifier, dispatcher } = build();
    const notice = {
      kind: 'admin-report' as const,
      subjectUserId: 'user_author',
      actorUserId: 'user_reporter',
      once: 'report:comment:c1:2026-11-13',
      refs: { inboxKey: 'report:comment:c1' },
    };
    await notifier.adminNotice(notice);
    await notifier.adminNotice(notice);
    await notifier.adminNotice({
      kind: 'admin-eam-request',
      subjectUserId: 'user_m',
      actorUserId: 'user_m',
      once: 'eam:1',
    });
    expect(queue.docs).toHaveLength(2);
    expect(queue.docs[0]).toMatchObject({
      userId: '@admins',
      category: 'adminReports',
      delivery: 'fanout',
      status: 'queued',
      subjectUserId: 'user_author',
      actorUserId: 'user_reporter',
      dedupeKey: 'admins:report:comment:c1:2026-11-13',
    });
    expect(queue.docs[1].refs).toEqual({});
    expect(dispatcher.kick).toHaveBeenCalledTimes(2);
    expect(
      MemberNotifier.reportOnce(
        'comment',
        'c1',
        new Date('2026-11-13T23:00:00Z'),
      ),
    ).toBe('report:comment:c1:2026-11-13');
    expect(MemberNotifier.reportOnce('comment', 'c1')).toMatch(
      /^report:comment:c1:\d{4}-\d{2}-\d{2}$/,
    );
  });

  it('never fails the action it reports', async () => {
    const { notifier, failWith } = build();
    failWith(new Error('database down'));
    await expect(
      notifier.claimDecided({
        claimId: 'k1',
        claimantUserId: 'user_c',
        actorUserId: 'user_admin',
        profileId: PAGE,
        approved: true,
      }),
    ).resolves.toBeUndefined();
    await expect(
      notifier.adminNotice({
        kind: 'admin-page-submitted',
        subjectUserId: 'u',
        actorUserId: 'u',
        once: 'p',
      }),
    ).resolves.toBeUndefined();
    failWith('a string');
    await notifier.adminNotice({
      kind: 'admin-page-submitted',
      subjectUserId: 'u',
      actorUserId: 'u',
      once: 'p',
    });
    await notifier.suggestionPosted({
      commentId: 's',
      actorUserId: 'w',
      ownerUserId: 'o',
    });
    expect(warn).toHaveBeenCalledTimes(4);
  });
});
