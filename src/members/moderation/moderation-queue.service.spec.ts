// The moderation queue and the moderator's actions (Chunk 13), with the real
// comment services over in-memory models. Transactions themselves are tested
// on a real replica set (test/moderation-mongo.e2e-spec.ts). Synthetic data.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { AdminInboxService } from '../../admin-inbox/admin-inbox.service';
import { reportKey } from '../../admin-inbox/schemas/admin-inbox.schema';
import { fakeConnection } from '../../db/transactions.mocks-spec';
import { ReportsStore } from '../../moderation/reports.store';
import { CommentVersionsService } from '../../social/comment-versions.service';
import {
  type FakeModel,
  fakeModel,
} from '../../test-support/fake-model.mocks-spec';
import { CommentAuthorsService } from '../comments/comment-authors.service';
import {
  harness,
  ids,
  type Harness,
  U,
} from '../comments/comments-harness.mocks-spec';
import {
  ACCEPTED_WORDING_STAYS,
  ALREADY_IN_STATE,
  COMMENT_BUSY_NOW,
  ModerationQueueService,
  NO_OPEN_REPORTS,
  NOT_MODERATED,
  OWN_CONTENT,
  QUEUE_PAGE_SIZE,
  REPORTS_SHOWN_PER_TARGET,
  TARGET_NOT_FOUND,
} from './moderation-queue.service';

const ADMIN = 'user_admin_b';
const SECRET = 'Synthetic words under review.';

interface Built {
  h: Harness;
  reports: FakeModel;
  inboxModel: FakeModel;
  log: { record: jest.Mock };
  service: ModerationQueueService;
}

function build(notifier?: unknown): Built {
  const h = harness();
  const reports = fakeModel([], { timestamps: true });
  const inboxModel = fakeModel([], { timestamps: true });
  const log = { record: jest.fn(() => Promise.resolve({})) };
  const { connection } = fakeConnection();
  const inbox = new AdminInboxService(
    inboxModel as never,
    h.profiles as never,
    connection as never,
    log as never,
  );
  const service = new ModerationQueueService(
    reports as never,
    h.comments as never,
    h.profiles as never,
    h.tabs as never,
    connection as never,
    new CommentVersionsService(h.commentVersions as never),
    new CommentAuthorsService(h.profiles as never),
    new ReportsStore(reports as never),
    inbox,
    log as never,
    notifier as never,
  );
  return { h, reports, inboxModel, log, service };
}

let minute = 0;
function report(
  b: Built,
  targetType: 'comment' | 'member-page',
  targetId: string,
  extra: Record<string, unknown> = {},
) {
  minute += 1;
  b.reports.docs.push({
    _id: new Types.ObjectId(),
    targetType,
    targetId,
    targetProfileId: ids.open,
    reporterUserId: U.anon,
    reason: 'spam',
    status: 'open',
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, minute)),
    ...extra,
  });
}

async function comment(h: Harness, userId = U.named) {
  const made = await h.commentsService.create(await h.writer(userId), {
    slug: 'open-page',
    tabId: 'tab_a',
    body: SECRET,
  });
  return made.commentId;
}

const stateOf = (b: Built, commentId: string) =>
  b.h.comments.docs.find((doc) => doc.commentId === commentId)!;

describe('ModerationQueueService.queue', () => {
  it('lists open reports by target, oldest first, with the text and its place', async () => {
    const b = build();
    const first = await comment(b.h);
    const second = await comment(b.h);
    report(b, 'comment', first, { note: 'Synthetic note.' });
    report(b, 'comment', second, { reporterUserId: U.owner });
    report(b, 'comment', first, { reporterUserId: U.owner, reason: 'hate' });
    report(b, 'comment', second, {
      status: 'resolved',
      resolution: 'dismissed',
    });

    const { entries, hasMore } = await b.service.queue(ADMIN, 'open', 1);
    expect(hasMore).toBe(false);
    expect(entries.map((e) => [e.targetId, e.count])).toEqual([
      [first, 2],
      [second, 1],
    ]);
    const [entry] = entries;
    expect(entry).toMatchObject({
      targetType: 'comment',
      ownContent: false,
      comment: {
        commentId: first,
        moderation: null,
        removedByAuthor: false,
        kind: 'comment',
        source: 'member',
        authorUserId: U.named,
        author: { kind: 'member', displayName: 'Name of named-writer' },
        body: SECRET,
        place: {
          kind: 'member-page',
          slug: 'open-page',
          displayName: 'Name of open-page',
          belief: { tabId: 'tab_a', title: 'Title tab_a', removed: false },
        },
      },
    });
    expect(entry.reports).toEqual([
      expect.objectContaining({
        reason: 'spam',
        note: 'Synthetic note.',
        reporterUserId: U.anon,
        reporter: expect.objectContaining({ kind: 'member' }) as unknown,
      }),
      expect.objectContaining({ reason: 'hate', reporterUserId: U.owner }),
    ]);
    expect(entry.firstReportedAt < entry.lastReportedAt).toBe(true);
  });

  it('lists closed reports, most recently closed first', async () => {
    const b = build();
    const first = await comment(b.h);
    const second = await comment(b.h);
    const closed = (at: number) => ({
      status: 'resolved',
      resolution: 'hidden',
      resolvedBy: ADMIN,
      resolvedAt: new Date(Date.UTC(2026, 10, 2, at)),
    });
    report(b, 'comment', first, closed(1));
    report(b, 'comment', second, closed(5));
    // An older row with no closing time: dated by its report.
    report(b, 'comment', 'cmt_missing', { status: 'resolved' });
    stateOf(b, second).stance = 'agree';
    const { entries } = await b.service.queue(ADMIN, 'resolved', 1);
    expect(entries.map((e) => e.targetId)).toEqual([
      second,
      first,
      'cmt_missing',
    ]);
    expect(entries[0].comment!.stance).toBe('agree');
    expect(entries[2].lastReportedAt).toBe(entries[2].firstReportedAt);
    expect(entries[0].reports[0]).toMatchObject({
      resolution: 'hidden',
      resolvedBy: ADMIN,
      resolvedAt: new Date(Date.UTC(2026, 10, 2, 5)).toISOString(),
    });
  });

  it('pages targets and caps the reports shown on one', async () => {
    const b = build();
    for (let i = 0; i < QUEUE_PAGE_SIZE + 1; i++) {
      report(b, 'comment', `cmt_missing_${String(i).padStart(2, '0')}`);
    }
    for (let i = 0; i < REPORTS_SHOWN_PER_TARGET + 2; i++) {
      report(b, 'comment', 'cmt_missing_00', { reporterUserId: `user_r${i}` });
    }
    const one = await b.service.queue(ADMIN, 'open', 1);
    expect(one.hasMore).toBe(true);
    expect(one.entries).toHaveLength(QUEUE_PAGE_SIZE);
    expect(one.entries[0]).toMatchObject({
      count: REPORTS_SHOWN_PER_TARGET + 3,
      missing: true,
      ownContent: false,
    });
    expect(one.entries[0].reports).toHaveLength(REPORTS_SHOWN_PER_TARGET);
    const two = await b.service.queue(ADMIN, 'open', 2);
    expect(two).toMatchObject({ hasMore: false });
    expect(two.entries).toHaveLength(1);
  });

  it('shows imported, admin-written, ORG-page and author-removed comments', async () => {
    const b = build();
    b.h.comments.docs.find((d) => d.commentId === 'cmt_imp2')!.linkedUserId =
      U.named;
    const org = await b.h.commentsService.createOnOrgPage(
      await b.h.writer(U.admin),
      { pageId: 'about', body: 'Synthetic admin words.' },
    );
    const removedOne = await comment(b.h);
    await b.h.commentsService.remove(U.named, removedOne);
    const suggestion = await b.h.suggestions.suggest(await b.h.writer(U.anon), {
      slug: 'open-page',
      tabId: 'tab_b',
      text: 'Synthetic rewording.',
      baseSeq: 1,
    });
    report(b, 'comment', 'cmt_imp1');
    report(b, 'comment', 'cmt_imp2');
    report(b, 'comment', org.commentId);
    report(b, 'comment', removedOne);
    report(b, 'comment', suggestion.commentId);
    report(b, 'comment', 'cmt_imp4');
    const { entries } = await b.service.queue(U.named, 'open', 1);
    const byId = new Map(entries.map((e) => [e.targetId, e]));
    expect(byId.get('cmt_imp1')!.comment).toMatchObject({
      source: 'imported',
      importedName: 'Synthetic Pages Author',
      author: { kind: 'imported', name: 'Synthetic Pages Author' },
      body: 'An imported synthetic comment.',
      place: { kind: 'member-page', slug: 'imported-page' },
    });
    expect(byId.get('cmt_imp1')!.comment).not.toHaveProperty('authorUserId');
    // Linked to the admin asking: their own words.
    expect(byId.get('cmt_imp2')).toMatchObject({
      ownContent: true,
      comment: { authorUserId: U.named },
    });
    expect(byId.get(org.commentId)!.comment).toMatchObject({
      author: { kind: 'admin' },
      place: { kind: 'org-page', pageId: 'about' },
    });
    expect(byId.get(removedOne)!.comment).toMatchObject({
      removedByAuthor: true,
      body: SECRET,
    });
    expect(byId.get(suggestion.commentId)!.comment).toMatchObject({
      kind: 'suggestion',
      proposedText: 'Synthetic rewording.',
    });
    // The page's own thread: no belief named.
    expect(byId.get('cmt_imp4')!.comment!.place).toEqual({
      kind: 'member-page',
      slug: 'imported-page',
      displayName: 'Name of imported-page',
    });
  });

  it('names a comment’s place even when its page or belief is gone', async () => {
    const b = build();
    report(b, 'comment', 'cmt_old_removed_tab');
    const imported = b.h.comments.docs.find((d) => d.commentId === 'cmt_imp1')!;
    imported.profileId = ids.gone;
    imported.tabId = 'tab_unknown';
    report(b, 'comment', 'cmt_imp1');
    const { entries } = await b.service.queue(ADMIN, 'open', 1);
    expect(entries[0].comment!.place).toMatchObject({
      belief: { tabId: 'tab_removed', removed: true },
    });
    expect(entries[1].comment!.place).toEqual({ kind: 'member-page' });
  });

  it('shows a reported member page, and whose it is', async () => {
    const b = build();
    report(b, 'member-page', String(ids.named));
    report(b, 'member-page', String(ids.imported));
    report(b, 'member-page', 'not-an-id');
    const { entries } = await b.service.queue(U.named, 'open', 1);
    expect(entries[0]).toMatchObject({
      ownContent: true,
      page: {
        slug: 'named-writer',
        displayName: 'Name of named-writer',
        reviewStatus: 'approved',
        ownerUserId: U.named,
      },
    });
    expect(entries[1]).toMatchObject({ ownContent: false });
    expect(entries[1].page).not.toHaveProperty('ownerUserId');
    expect(entries[2]).toMatchObject({ missing: true });
    b.h.profiles.docs.find((d) =>
      ids.named.equals(d._id as never),
    )!.reviewStatus = undefined;
    const again = await b.service.queue(ADMIN, 'open', 1);
    expect(again.entries[0].page!.reviewStatus).toBe('approved');
  });
});

describe('ModerationQueueService.moderateComment', () => {
  it('hides a comment, closes its reports and notice, and logs it', async () => {
    const b = build();
    const commentId = await comment(b.h);
    report(b, 'comment', commentId);
    report(b, 'comment', commentId, { reporterUserId: U.owner });
    b.inboxModel.docs.push({
      kind: 'report',
      status: 'open',
      dedupeKey: reportKey('comment', commentId),
      subjectUserId: U.named,
    });
    await expect(
      b.service.moderateComment(
        ADMIN,
        commentId,
        'hide',
        ' Synthetic\u0007 reason ',
      ),
    ).resolves.toEqual({ moderation: 'hidden', reportsClosed: 2 });
    expect(stateOf(b, commentId)).toMatchObject({
      moderation: 'hidden',
      moderatedBy: ADMIN,
      body: SECRET,
    });
    expect(b.reports.docs.map((r) => [r.status, r.resolution])).toEqual([
      ['resolved', 'hidden'],
      ['resolved', 'hidden'],
    ]);
    expect(b.inboxModel.docs[0]).toMatchObject({
      status: 'handled',
      handledBy: ADMIN,
    });
    expect(b.log.record).toHaveBeenCalledWith(
      {
        actorUserId: ADMIN,
        action: 'comment.hidden',
        targetType: 'comment',
        targetId: commentId,
        reason: 'Synthetic reason',
        details: {
          before: 'shown',
          reportsClosed: 2,
          profileId: String(ids.open),
          tabId: 'tab_a',
          authorUserId: U.named,
        },
      },
      expect.anything(),
    );
  });

  it('turns a hidden comment into a removed one, then restores it', async () => {
    const b = build();
    const commentId = await comment(b.h);
    await b.service.moderateComment(ADMIN, commentId, 'hide', 'r');
    await expect(
      b.service.moderateComment(ADMIN, commentId, 'remove', 'r'),
    ).resolves.toEqual({ moderation: 'removed', reportsClosed: 0 });
    expect(b.log.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'comment.removed',
        details: expect.objectContaining({ before: 'hidden' }) as unknown,
      }),
      expect.anything(),
    );
    report(b, 'comment', commentId);
    await expect(
      b.service.moderateComment(ADMIN, commentId, 'restore', 'r'),
    ).resolves.toEqual({ moderation: null, reportsClosed: 1 });
    const row = stateOf(b, commentId);
    expect(row.moderation).toBeUndefined();
    expect(row.moderatedAt).toBeUndefined();
    expect(row.moderatedBy).toBeUndefined();
    expect(b.reports.docs[0].resolution).toBe('restored');
    expect(b.log.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'comment.restored' }),
      expect.anything(),
    );
  });

  it('works on an imported comment, whose log names no author', async () => {
    const b = build();
    await b.service.moderateComment(ADMIN, 'cmt_imp4', 'remove', 'r');
    expect(b.log.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        details: {
          before: 'shown',
          reportsClosed: 0,
          profileId: String(ids.imported),
        },
      }),
      expect.anything(),
    );
  });

  it('refuses the same state twice, and restoring what is shown', async () => {
    const b = build();
    const commentId = await comment(b.h);
    await expect(
      b.service.moderateComment(ADMIN, commentId, 'restore', 'r'),
    ).rejects.toThrow(new ConflictException(NOT_MODERATED));
    await b.service.moderateComment(ADMIN, commentId, 'remove', 'r');
    await expect(
      b.service.moderateComment(ADMIN, commentId, 'remove', 'r'),
    ).rejects.toThrow(new ConflictException(ALREADY_IN_STATE));
  });

  it('never acts on the admin’s own words, written or linked', async () => {
    const b = build();
    const commentId = await comment(b.h, U.admin);
    await expect(
      b.service.moderateComment(U.admin, commentId, 'hide', 'r'),
    ).rejects.toThrow(new ForbiddenException(OWN_CONTENT));
    stateOf(b, 'cmt_imp1').linkedUserId = ADMIN;
    await expect(
      b.service.moderateComment(ADMIN, 'cmt_imp1', 'hide', 'r'),
    ).rejects.toThrow(new ForbiddenException(OWN_CONTENT));
  });

  it('answers 404 for no comment, and 400 without a reason', async () => {
    const b = build();
    await expect(
      b.service.moderateComment(ADMIN, 'cmt_nope', 'hide', 'r'),
    ).rejects.toThrow(new NotFoundException(TARGET_NOT_FOUND));
    await expect(
      b.service.moderateComment(ADMIN, 'cmt_imp1', 'hide', ' ​ '),
    ).rejects.toThrow(BadRequestException);
  });

  it('waits for an edit or an accept in progress, but not a dead one', async () => {
    const b = build();
    const commentId = await comment(b.h);
    const row = stateOf(b, commentId);
    row.editTurns = [{ id: 'turn', at: new Date() }];
    await expect(
      b.service.moderateComment(ADMIN, commentId, 'hide', 'r'),
    ).rejects.toThrow(new ConflictException(COMMENT_BUSY_NOW));
    row.editTurns = [{ id: 'turn', at: new Date(Date.now() - 6 * 60_000) }];
    await expect(
      b.service.moderateComment(ADMIN, commentId, 'hide', 'r'),
    ).resolves.toMatchObject({ moderation: 'hidden' });

    const { commentId: suggestionId } = await b.h.suggestions.suggest(
      await b.h.writer(U.anon),
      { slug: 'open-page', tabId: 'tab_b', text: 'Rewording.', baseSeq: 1 },
    );
    const suggestion = stateOf(b, suggestionId).suggestion as Record<
      string,
      unknown
    >;
    suggestion.status = 'accepting';
    suggestion.lockedAt = new Date();
    await expect(
      b.service.moderateComment(ADMIN, suggestionId, 'hide', 'r'),
    ).rejects.toThrow(new ConflictException(COMMENT_BUSY_NOW));
    suggestion.lockedAt = new Date(Date.now() - 3 * 60_000);
    await expect(
      b.service.moderateComment(ADMIN, suggestionId, 'hide', 'r'),
    ).resolves.toMatchObject({ moderation: 'hidden' });
  });

  it('answers 409 when a restore loses a race', async () => {
    const b = build();
    const commentId = await comment(b.h);
    await b.service.moderateComment(ADMIN, commentId, 'hide', 'r');
    jest.spyOn(b.h.comments, 'updateOne').mockReturnValueOnce({
      exec: () => Promise.resolve({ matchedCount: 0, modifiedCount: 0 }),
    });
    await expect(
      b.service.moderateComment(ADMIN, commentId, 'restore', 'r'),
    ).rejects.toThrow(new ConflictException(COMMENT_BUSY_NOW));
  });
});

describe('ModerationQueueService.dismiss', () => {
  it('closes a target’s open reports with nothing done, and logs it', async () => {
    const b = build();
    const commentId = await comment(b.h);
    report(b, 'comment', commentId);
    report(b, 'comment', commentId, {
      status: 'resolved',
      resolution: 'hidden',
    });
    await expect(
      b.service.dismiss(ADMIN, 'comment', commentId, 'Synthetic: fine'),
    ).resolves.toEqual({ dismissed: 1 });
    expect(b.reports.docs.map((r) => r.resolution)).toEqual([
      'dismissed',
      'hidden',
    ]);
    expect(stateOf(b, commentId).moderation).toBeUndefined();
    expect(b.log.record).toHaveBeenCalledWith(
      {
        actorUserId: ADMIN,
        action: 'reports.dismissed',
        targetType: 'comment',
        targetId: commentId,
        reason: 'Synthetic: fine',
        details: { reportsClosed: 1 },
      },
      expect.anything(),
    );
  });

  it('dismisses reports on a member page, never the admin’s own', async () => {
    const b = build();
    report(b, 'member-page', String(ids.named));
    await expect(
      b.service.dismiss(U.named, 'member-page', String(ids.named), 'r'),
    ).rejects.toThrow(new ForbiddenException(OWN_CONTENT));
    await expect(
      b.service.dismiss(ADMIN, 'member-page', String(ids.named), 'r'),
    ).resolves.toEqual({ dismissed: 1 });
    // A page id that names nothing, and a malformed one.
    await expect(
      b.service.dismiss(
        ADMIN,
        'member-page',
        String(new Types.ObjectId()),
        'r',
      ),
    ).rejects.toThrow(new NotFoundException(NO_OPEN_REPORTS));
    await expect(
      b.service.dismiss(ADMIN, 'member-page', 'not-an-id', 'r'),
    ).rejects.toThrow(new NotFoundException(NO_OPEN_REPORTS));
  });

  it('refuses the admin’s own comment, and a target with no open report', async () => {
    const b = build();
    const own = await comment(b.h, U.admin);
    report(b, 'comment', own);
    await expect(
      b.service.dismiss(U.admin, 'comment', own, 'r'),
    ).rejects.toThrow(new ForbiddenException(OWN_CONTENT));
    stateOf(b, 'cmt_imp1').linkedUserId = ADMIN;
    await expect(
      b.service.dismiss(ADMIN, 'comment', 'cmt_imp1', 'r'),
    ).rejects.toThrow(new ForbiddenException(OWN_CONTENT));
    await expect(
      b.service.dismiss(ADMIN, 'comment', 'cmt_nope', 'r'),
    ).rejects.toThrow(new NotFoundException(NO_OPEN_REPORTS));
  });
});

describe('an accepted suggestion (review L-2)', () => {
  it('can be hidden, and the queue and the answer say the belief keeps its wording', async () => {
    const b = build();
    const { commentId } = await b.h.suggestions.suggest(
      await b.h.writer(U.anon),
      {
        slug: 'open-page',
        tabId: 'tab_b',
        text: 'Synthetic accepted.',
        baseSeq: 1,
      },
    );
    await b.h.suggestions.accept(U.owner, commentId);
    report(b, 'comment', commentId);
    const { entries } = await b.service.queue(ADMIN, 'open', 1);
    expect(entries[0].comment).toMatchObject({
      kind: 'suggestion',
      suggestionStatus: 'accepted',
    });
    await expect(
      b.service.moderateComment(ADMIN, commentId, 'hide', 'r'),
    ).resolves.toEqual({
      moderation: 'hidden',
      reportsClosed: 1,
      note: ACCEPTED_WORDING_STAYS,
    });
    // Restoring says nothing more; a pending suggestion has no note either.
    await expect(
      b.service.moderateComment(ADMIN, commentId, 'restore', 'r'),
    ).resolves.toEqual({ moderation: null, reportsClosed: 0 });
    const pending = await b.h.suggestions.suggest(await b.h.writer(U.named), {
      slug: 'open-page',
      tabId: 'tab_a',
      text: 'Synthetic pending.',
      baseSeq: 1,
    });
    stateOf(b, pending.commentId).suggestion = {
      ...(stateOf(b, pending.commentId).suggestion as object),
      status: 'accepting',
      lockedAt: new Date(0),
    };
    report(b, 'comment', pending.commentId);
    const again = await b.service.queue(ADMIN, 'open', 1);
    expect(
      again.entries.find((e) => e.targetId === pending.commentId)!.comment,
    ).toMatchObject({ suggestionStatus: 'pending' });
    await expect(
      b.service.moderateComment(ADMIN, pending.commentId, 'hide', 'r'),
    ).resolves.not.toHaveProperty('note');
  });
});

describe('ModerationQueueService: telling the author (Chunk 14)', () => {
  it('tells the author each decision after it is saved, and nobody when it fails', async () => {
    const commentModerated = jest.fn(() => Promise.resolve());
    const b = build({ commentModerated });
    const commentId = await comment(b.h);
    await b.service.moderateComment(ADMIN, commentId, 'hide', 'r');
    await b.service.moderateComment(ADMIN, commentId, 'remove', 'r');
    await b.service.moderateComment(ADMIN, commentId, 'restore', 'r');
    await expect(
      b.service.moderateComment(ADMIN, commentId, 'restore', 'r'),
    ).rejects.toThrow(NOT_MODERATED);
    expect(commentModerated.mock.calls).toEqual([
      [
        {
          commentId,
          authorUserId: U.named,
          actorUserId: ADMIN,
          state: 'hidden',
        },
      ],
      [
        {
          commentId,
          authorUserId: U.named,
          actorUserId: ADMIN,
          state: 'removed',
        },
      ],
      [{ commentId, authorUserId: U.named, actorUserId: ADMIN, state: null }],
    ]);
    // An imported comment: its linked account, or nobody.
    await b.service.moderateComment(ADMIN, 'cmt_imp4', 'hide', 'r');
    expect(commentModerated).toHaveBeenLastCalledWith(
      expect.objectContaining({
        commentId: 'cmt_imp4',
        authorUserId: undefined,
      }),
    );
    stateOf(b, 'cmt_imp1').linkedUserId = U.owner;
    await b.service.moderateComment(ADMIN, 'cmt_imp1', 'hide', 'r');
    expect(commentModerated).toHaveBeenLastCalledWith(
      expect.objectContaining({ commentId: 'cmt_imp1', authorUserId: U.owner }),
    );
  });
});
