// The "Report" button (Chunk 13) with the real comment and page services
// over in-memory models. Synthetic data only.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { fakeConnection } from '../../db/transactions.mocks-spec';
import { ReportQuotaStore, utcDay } from '../../moderation/report-quota.store';
import { fakeModel } from '../../test-support/fake-model.mocks-spec';
import {
  harness,
  ids,
  type Harness,
  U,
} from '../comments/comments-harness.mocks-spec';
import { COMMENT_NOT_FOUND } from '../comments/comments.service';
import {
  ALREADY_REPORTED,
  NOT_REPORTABLE,
  REPORT_LIMIT,
  REPORT_NOTE_TOO_LONG,
  REPORT_OWN_CONTENT,
  REPORT_PAGE_NOT_FOUND,
  REPORT_TARGET_MISSING,
  REPORTS_PER_DAY,
  ReportsService,
} from './reports.service';

function build(notify: () => Promise<void> = () => Promise.resolve()) {
  const h = harness();
  const reports = fakeModel([], {
    unique: [['targetType', 'targetId', 'reporterUserId', 'status']],
    timestamps: true,
  });
  const inbox = { notifyReport: jest.fn(notify) };
  const quotas = fakeModel([], { unique: [['reporterUserId', 'day']] });
  const quota = new ReportQuotaStore(quotas as never);
  const { connection } = fakeConnection();
  const service = new ReportsService(
    reports as never,
    h.store,
    h.commentsService,
    h.members,
    h.orgPages,
    inbox as never,
    quota,
    h.comments as never,
    connection as never,
  );
  return { h, reports, inbox, service, quotas, quota };
}

async function comment(h: Harness, userId: string, slug = 'open-page') {
  const made = await h.commentsService.create(await h.writer(userId), {
    slug,
    ...(slug === 'open-page' ? { tabId: 'tab_a' } : {}),
    body: 'Synthetic words someone may report.',
  });
  return made.commentId;
}

describe('ReportsService (Chunk 13)', () => {
  it('stores a report on a comment and tells the admins’ inbox, nothing more', async () => {
    const { h, reports, inbox, service } = build();
    const commentId = await comment(h, U.named);
    await expect(
      service.report(await h.writer(U.anon), {
        targetType: 'comment',
        commentId,
        reason: 'harassment',
        note: '  Synthetic\u0007 note.  ',
      }),
    ).resolves.toEqual({ reported: true });
    expect(reports.docs).toEqual([
      expect.objectContaining({
        targetType: 'comment',
        targetId: commentId,
        targetProfileId: ids.open,
        reporterUserId: U.anon,
        reason: 'harassment',
        note: 'Synthetic note.',
        status: 'open',
      }),
    ]);
    expect(inbox.notifyReport).toHaveBeenCalledWith({
      targetType: 'comment',
      targetId: commentId,
      subjectUserId: U.named,
      profileId: ids.open,
    });
  });

  it('leaves out an empty note, and refuses one too long once cleaned', async () => {
    const { h, reports, service } = build();
    const commentId = await comment(h, U.named);
    const writer = await h.writer(U.anon);
    await service.report(writer, {
      targetType: 'comment',
      commentId,
      reason: 'spam',
      note: ' ​ ',
    });
    expect(reports.docs[0]).not.toHaveProperty('note');
    await expect(
      service.report(writer, {
        targetType: 'comment',
        commentId,
        reason: 'spam',
        note: 'x'.repeat(1_001),
      }),
    ).rejects.toThrow(new BadRequestException(REPORT_NOTE_TOO_LONG));
  });

  it('allows one open report per reporter per target', async () => {
    const { h, service, quotas } = build();
    const commentId = await comment(h, U.named);
    const writer = await h.writer(U.anon);
    const input = {
      targetType: 'comment' as const,
      commentId,
      reason: 'spam' as const,
    };
    await service.report(writer, input);
    await expect(service.report(writer, input)).rejects.toThrow(
      new ConflictException(ALREADY_REPORTED),
    );
    // The refused report gave its slot back.
    expect(quotas.docs).toEqual([
      expect.objectContaining({ reporterUserId: U.anon, n: 1 }),
    ]);
    // Someone else may report it too.
    await expect(
      service.report(await h.writer(U.owner), input),
    ).resolves.toEqual({ reported: true });
  });

  it('passes on any other storage failure', async () => {
    const { h, reports, service } = build();
    const commentId = await comment(h, U.named);
    jest
      .spyOn(reports, 'create')
      .mockRejectedValueOnce(new Error('synthetic outage'));
    await expect(
      service.report(await h.writer(U.anon), {
        targetType: 'comment',
        commentId,
        reason: 'spam',
      }),
    ).rejects.toThrow('synthetic outage');
  });

  it('caps reports per day', async () => {
    const { h, quotas, service } = build();
    const commentId = await comment(h, U.named);
    const today = utcDay(new Date());
    quotas.docs.push(
      {
        _id: `${U.anon}|${today}`,
        reporterUserId: U.anon,
        day: today,
        n: REPORTS_PER_DAY - 1,
      },
      // Yesterday's counter does not count.
      {
        _id: `${U.anon}|2000-01-01`,
        reporterUserId: U.anon,
        day: '2000-01-01',
        n: REPORTS_PER_DAY,
      },
    );
    const writer = await h.writer(U.anon);
    await service.report(writer, {
      targetType: 'comment',
      commentId,
      reason: 'spam',
    });
    const error = await service
      .report(await h.writer(U.anon), {
        targetType: 'member-page',
        slug: 'named-writer',
        reason: 'spam',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect((error as HttpException).message).toBe(REPORT_LIMIT);
  });

  it('never reports your own words, nor an imported comment linked to you', async () => {
    const { h, service } = build();
    const commentId = await comment(h, U.named);
    await expect(
      service.report(await h.writer(U.named), {
        targetType: 'comment',
        commentId,
        reason: 'spam',
      }),
    ).rejects.toThrow(new ForbiddenException(REPORT_OWN_CONTENT));
    const imported = h.comments.docs.find(
      (doc) => doc.commentId === 'cmt_imp1',
    )!;
    imported.linkedUserId = U.anon;
    await expect(
      service.report(await h.writer(U.anon), {
        targetType: 'comment',
        commentId: 'cmt_imp1',
        reason: 'spam',
      }),
    ).rejects.toThrow(new ForbiddenException(REPORT_OWN_CONTENT));
  });

  it('names the linked member or the import as the inbox subject', async () => {
    const { h, inbox, service } = build();
    const writer = await h.writer(U.named);
    await service.report(writer, {
      targetType: 'comment',
      commentId: 'cmt_imp2',
      reason: 'off-topic',
    });
    expect(inbox.notifyReport).toHaveBeenLastCalledWith(
      expect.objectContaining({ subjectUserId: 'imported:cmt_imp2' }),
    );
    h.comments.docs.find((doc) => doc.commentId === 'cmt_imp1')!.linkedUserId =
      U.owner;
    await service.report(writer, {
      targetType: 'comment',
      commentId: 'cmt_imp1',
      reason: 'off-topic',
    });
    expect(inbox.notifyReport).toHaveBeenLastCalledWith(
      expect.objectContaining({ subjectUserId: U.owner }),
    );
  });

  it('answers the same 404 for a comment unknown or out of the reporter’s sight', async () => {
    const { h, service } = build();
    const writer = await h.writer(U.anon);
    const notFound = new NotFoundException(COMMENT_NOT_FOUND);
    // Unknown.
    await expect(
      service.report(writer, {
        targetType: 'comment',
        commentId: 'cmt_nope',
        reason: 'spam',
      }),
    ).rejects.toThrow(notFound);
    // On an unlisted page.
    const hiddenOne = await h.commentsService.create(await h.writer(U.admin), {
      slug: 'hidden-page',
      tabId: 'tab_h',
      body: 'Synthetic.',
    });
    await expect(
      service.report(writer, {
        targetType: 'comment',
        commentId: hiddenOne.commentId,
        reason: 'spam',
      }),
    ).rejects.toThrow(notFound);
    // On a removed belief.
    await expect(
      service.report(writer, {
        targetType: 'comment',
        commentId: 'cmt_old_removed_tab',
        reason: 'spam',
      }),
    ).rejects.toThrow(notFound);
    // On a page that is gone.
    const row = h.comments.docs.find((doc) => doc.commentId === 'cmt_imp4')!;
    row.profileId = ids.gone;
    await expect(
      service.report(writer, {
        targetType: 'comment',
        commentId: 'cmt_imp4',
        reason: 'spam',
      }),
    ).rejects.toThrow(notFound);
    // On a page that no longer exists at all.
    h.profiles.docs.splice(
      h.profiles.docs.findIndex((doc) => ids.gone.equals(doc._id as never)),
      1,
    );
    await expect(
      service.report(writer, {
        targetType: 'comment',
        commentId: 'cmt_imp4',
        reason: 'spam',
      }),
    ).rejects.toThrow(notFound);
  });

  it('passes on a failure that is not a 404 while checking the page', async () => {
    const { h, service } = build();
    const commentId = await comment(h, U.named);
    jest
      .spyOn(h.commentsService, 'readablePage')
      .mockRejectedValueOnce(new ServiceUnavailableException('synthetic'));
    await expect(
      service.report(await h.writer(U.anon), {
        targetType: 'comment',
        commentId,
        reason: 'spam',
      }),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('reports a comment on an ORG page while the page is published', async () => {
    const { h, inbox, service } = build();
    const made = await h.commentsService.createOnOrgPage(
      await h.writer(U.named),
      { pageId: 'about', body: 'Synthetic.' },
    );
    const writer = await h.writer(U.anon);
    await service.report(writer, {
      targetType: 'comment',
      commentId: made.commentId,
      reason: 'other',
    });
    expect(inbox.notifyReport).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: ids.orgAbout }),
    );
    // Unpublished: the same 404 as no comment.
    const page = h.pages.docs.find((doc) => doc.pageId === 'about')!;
    delete page.published;
    await expect(
      service.report(await h.writer(U.owner), {
        targetType: 'comment',
        commentId: made.commentId,
        reason: 'other',
      }),
    ).rejects.toThrow(new NotFoundException(COMMENT_NOT_FOUND));
  });

  it('reports a comment on a page’s own thread', async () => {
    const { h, reports, service } = build();
    await service.report(await h.writer(U.anon), {
      targetType: 'comment',
      commentId: 'cmt_imp4',
      reason: 'other',
    });
    expect(reports.docs[0].targetId).toBe('cmt_imp4');
  });

  it('reports a reply through its thread', async () => {
    const { h, reports, service } = build();
    const root = await comment(h, U.named);
    const reply = await h.commentsService.create(await h.writer(U.owner), {
      slug: 'open-page',
      parentCommentId: root,
      body: 'Synthetic reply.',
    });
    await service.report(await h.writer(U.anon), {
      targetType: 'comment',
      commentId: reply.commentId,
      reason: 'spam',
    });
    expect(reports.docs[0].targetId).toBe(reply.commentId);
  });

  it('refuses a comment already taken down', async () => {
    const { h, service } = build();
    const commentId = await comment(h, U.named);
    const writer = await h.writer(U.anon);
    h.comments.docs.find((doc) => doc.commentId === commentId)!.moderation =
      'hidden';
    await expect(
      service.report(writer, {
        targetType: 'comment',
        commentId,
        reason: 'spam',
      }),
    ).rejects.toThrow(new ConflictException(NOT_REPORTABLE));
    const other = await comment(h, U.named);
    await h.commentsService.remove(U.named, other);
    await expect(
      service.report(writer, {
        targetType: 'comment',
        commentId: other,
        reason: 'spam',
      }),
    ).rejects.toThrow(new ConflictException(NOT_REPORTABLE));
  });

  it('reports a member page the reporter can see, never their own', async () => {
    const { h, inbox, service } = build();
    const writer = await h.writer(U.anon);
    await service.report(writer, {
      targetType: 'member-page',
      slug: 'Named-Writer',
      reason: 'personal-information',
    });
    expect(inbox.notifyReport).toHaveBeenCalledWith({
      targetType: 'member-page',
      targetId: String(ids.named),
      subjectUserId: U.named,
      profileId: ids.named,
    });
    // An imported page with no owner yet.
    await service.report(writer, {
      targetType: 'member-page',
      slug: 'imported-page',
      reason: 'other',
    });
    expect(inbox.notifyReport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        subjectUserId: `imported-page:${String(ids.imported)}`,
      }),
    );
    await expect(
      service.report(writer, {
        targetType: 'member-page',
        slug: 'anon-writer',
        reason: 'other',
      }),
    ).rejects.toThrow(new ForbiddenException(REPORT_OWN_CONTENT));
    for (const slug of ['hidden-page', 'waiting-page', 'gone-page', 'nope']) {
      await expect(
        service.report(writer, {
          targetType: 'member-page',
          slug,
          reason: 'other',
        }),
      ).rejects.toThrow(new NotFoundException(REPORT_PAGE_NOT_FOUND));
    }
  });

  it('passes on a failure that is not a 404 while finding a page', async () => {
    const { h, service } = build();
    jest
      .spyOn(h.members, 'findVisible')
      .mockRejectedValueOnce(new ServiceUnavailableException('synthetic'));
    await expect(
      service.report(await h.writer(U.anon), {
        targetType: 'member-page',
        slug: 'named-writer',
        reason: 'other',
      }),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('needs the target the type names', async () => {
    const { h, service } = build();
    const writer = await h.writer(U.anon);
    await expect(
      service.report(writer, { targetType: 'comment', reason: 'spam' }),
    ).rejects.toThrow(new BadRequestException(REPORT_TARGET_MISSING));
    await expect(
      service.report(writer, { targetType: 'member-page', reason: 'spam' }),
    ).rejects.toThrow(new BadRequestException(REPORT_TARGET_MISSING));
  });

  it('keeps the report when the inbox notice fails', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { h, reports, service } = build(() =>
      Promise.reject(new Error('synthetic inbox outage')),
    );
    const commentId = await comment(h, U.named);
    await expect(
      service.report(await h.writer(U.anon), {
        targetType: 'comment',
        commentId,
        reason: 'spam',
      }),
    ).resolves.toEqual({ reported: true });
    expect(reports.docs).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('synthetic inbox outage'),
    );
    warn.mockRestore();
  });
});

describe('ReportsService: a report racing a decision (review L-4)', () => {
  it('marks the comment it reports, in the same write as the report', async () => {
    const { h, service } = build();
    const commentId = await comment(h, U.named);
    await service.report(await h.writer(U.anon), {
      targetType: 'comment',
      commentId,
      reason: 'spam',
    });
    expect(
      h.comments.docs.find((doc) => doc.commentId === commentId)!
        .lastReportedAt,
    ).toBeInstanceOf(Date);
  });

  it('refuses, and gives the slot back, when the comment was taken down meanwhile', async () => {
    const { h, reports, quotas, service } = build();
    const commentId = await comment(h, U.named);
    jest.spyOn(h.comments, 'updateOne').mockReturnValueOnce({
      exec: () => Promise.resolve({ matchedCount: 0, modifiedCount: 0 }),
    });
    await expect(
      service.report(await h.writer(U.anon), {
        targetType: 'comment',
        commentId,
        reason: 'spam',
      }),
    ).rejects.toThrow(new ConflictException(NOT_REPORTABLE));
    expect(reports.docs).toHaveLength(0);
    expect(quotas.docs[0]).toMatchObject({ n: 0 });
  });
});
