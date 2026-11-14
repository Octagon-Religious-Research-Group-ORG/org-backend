import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model, Types } from 'mongoose';
import { AdminInboxService } from '../../admin-inbox/admin-inbox.service';
import { inTransaction } from '../../db/transactions';
import { ReportQuotaStore } from '../../moderation/report-quota.store';
import {
  Comment,
  type CommentDocument,
} from '../../social/schemas/comment.schema';
import {
  cleanMemberParagraphs,
  hasVisibleText,
} from '../../membership/member-text';
import {
  MAX_REPORT_NOTE_LENGTH,
  Report,
  type ReportDocument,
  type ReportReason,
  type ReportTargetType,
} from '../../moderation/schemas/report.schema';
import { describeFailure } from '../comments/comment-limits';
import { CommentStore, type StoredComment } from '../comments/comment-store';
import type { CommentWriter } from '../comments/comment-writers';
import {
  COMMENT_NOT_FOUND,
  CommentsService,
} from '../comments/comments.service';
import { MembersService } from '../members.service';
import { orgPageIdOfThread } from '../org-pages/org-page-targets';
import { OrgPagesService } from '../org-pages/org-pages.service';

/**
 * Reports one member may send per UTC day, on top of the write ration. Held
 * atomically by {@link ReportQuotaStore} (review M-1).
 */
export const REPORTS_PER_DAY = 10;

export const REPORT_OWN_CONTENT = 'You cannot report your own words or page.';
export const ALREADY_REPORTED =
  'You have already reported this. An admin will look at it.';
export const NOT_REPORTABLE = 'That comment is no longer shown.';
export const REPORT_LIMIT =
  "You've sent today's reports. If something is urgent, please contact Tripp.";
export const REPORT_NOTE_TOO_LONG = `A note can hold at most ${MAX_REPORT_NOTE_LENGTH.toLocaleString('en-US')} characters.`;
export const REPORT_TARGET_MISSING =
  'Say which comment or page you are reporting.';
export const REPORT_PAGE_NOT_FOUND = 'That page does not exist.';

export interface NewReportInput {
  targetType: ReportTargetType;
  /** For a comment. */
  commentId?: string;
  /** For a member page. */
  slug?: string;
  reason: ReportReason;
  note?: string;
}

/** What the target is, as far as a report needs to know. */
interface ReportTarget {
  targetId: string;
  targetProfileId: Types.ObjectId;
  /** The author or owner, for the inbox (and never the reporter). */
  subjectUserId: string;
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * The "Report" button (Chunk 13), on every comment and on member pages.
 *
 * - Who: the same accounts that may comment (`CommentWritersService`): a
 *   verified email and an approved page of any kind, anonymous included,
 *   or an admin. An account with no page cannot report, so a throwaway
 *   account cannot fill the queue.
 * - What: only what the reporter can see now. A comment or page they cannot
 *   read gets the same 404 as one that does not exist.
 * - Never their own words or page; one open report per target; at most
 *   {@link REPORTS_PER_DAY} a day, on top of the member write ration. The
 *   cap is one atomic counter, so parallel reports cannot pass it.
 * - A comment report is written in one transaction with a write to the
 *   comment itself (`lastReportedAt`), only while no moderator decision and
 *   no author removal stands. A hide or removal also writes the comment, so
 *   the two always conflict and one retries (review L-4): a report never
 *   stays open on a comment that was already taken down.
 * - The answer says only that the report was received: never how many
 *   others reported it. The reported member is told nothing.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @InjectModel(Report.name)
    private readonly reportModel: Model<ReportDocument>,
    private readonly store: CommentStore,
    private readonly comments: CommentsService,
    private readonly members: MembersService,
    private readonly orgPages: OrgPagesService,
    private readonly inbox: AdminInboxService,
    private readonly quota: ReportQuotaStore,
    @InjectModel(Comment.name)
    private readonly commentModel: Model<CommentDocument>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /**
   * @throws NotFoundException for a target this reporter cannot see
   * @throws ForbiddenException for their own content
   * @throws ConflictException for a comment already taken down, or a
   *   target they already reported
   * @throws HttpException 429 past the daily cap
   * @throws BadRequestException for a note too long, or no target named
   */
  async report(writer: CommentWriter, input: NewReportInput) {
    const note = cleanMemberParagraphs(input.note ?? '').trim();
    if (note.length > MAX_REPORT_NOTE_LENGTH) {
      throw new BadRequestException(REPORT_NOTE_TOO_LONG);
    }
    const target =
      input.targetType === 'comment'
        ? await this.commentTarget(writer, input.commentId)
        : await this.pageTarget(writer, input.slug);

    const day = await this.quota.take(writer.userId, REPORTS_PER_DAY);
    if (day === undefined) {
      throw new HttpException(REPORT_LIMIT, HttpStatus.TOO_MANY_REQUESTS);
    }
    const row = {
      targetType: input.targetType,
      targetId: target.targetId,
      targetProfileId: target.targetProfileId,
      reporterUserId: writer.userId,
      reason: input.reason,
      ...(hasVisibleText(note) ? { note } : {}),
      status: 'open' as const,
    };
    try {
      if (input.targetType === 'comment') {
        await inTransaction(this.connection, (session) =>
          this.storeCommentReport(row, session),
        );
      } else {
        await this.reportModel.create(row);
      }
    } catch (error) {
      await this.quota.giveBack(writer.userId, day);
      if (isDuplicateKey(error)) throw new ConflictException(ALREADY_REPORTED);
      throw error;
    }
    try {
      await this.inbox.notifyReport({
        targetType: input.targetType,
        targetId: target.targetId,
        subjectUserId: target.subjectUserId,
        profileId: target.targetProfileId,
      });
    } catch (error) {
      // Best effort: the report is in the queue whatever happens here.
      this.logger.warn(
        `A report was saved, but its inbox notice was not: ${describeFailure(error)}`,
      );
    }
    return { reported: true };
  }

  /**
   * The report and the comment's `lastReportedAt`, together, only while the
   * comment is still shown (see the class note).
   *
   * @throws ConflictException when a decision or removal landed meanwhile
   */
  private async storeCommentReport(
    row: { targetId: string } & Record<string, unknown>,
    session: ClientSession,
  ) {
    const touched = await this.commentModel
      .updateOne(
        {
          commentId: row.targetId,
          moderation: { $exists: false },
          removedAt: { $exists: false },
        },
        { $set: { lastReportedAt: new Date() } },
        { session },
      )
      .exec();
    if (touched.modifiedCount !== 1) {
      throw new ConflictException(NOT_REPORTABLE);
    }
    await this.reportModel.create([row], { session });
  }

  /** A comment the reporter can read in its thread right now. */
  private async commentTarget(
    writer: CommentWriter,
    commentId: string | undefined,
  ): Promise<ReportTarget> {
    if (commentId === undefined) {
      throw new BadRequestException(REPORT_TARGET_MISSING);
    }
    const row = await this.store.one(commentId);
    if (!row) throw new NotFoundException(COMMENT_NOT_FOUND);
    // Listed a moment ago, so it has a root on its own page.
    const root = (await this.store.rootOf(
      row.profileId,
      commentId,
    )) as StoredComment;
    const orgPageId = orgPageIdOfThread(root.tabId);
    if (orgPageId !== undefined) {
      if (!(await this.orgPages.forThread(String(root.tabId)))) {
        throw new NotFoundException(COMMENT_NOT_FOUND);
      }
    } else {
      const slug = await this.members.slugOf(row.profileId);
      if (slug === undefined) throw new NotFoundException(COMMENT_NOT_FOUND);
      try {
        await this.comments.readablePage(slug, writer);
        if (root.tabId !== undefined) {
          await this.comments.requireLiveTab(row.profileId, root.tabId);
        }
      } catch (error) {
        if (error instanceof NotFoundException) {
          throw new NotFoundException(COMMENT_NOT_FOUND);
        }
        throw error;
      }
    }
    if (
      row.authorUserId === writer.userId ||
      row.linkedUserId === writer.userId
    ) {
      throw new ForbiddenException(REPORT_OWN_CONTENT);
    }
    if (row.removedAt || row.moderation) {
      throw new ConflictException(NOT_REPORTABLE);
    }
    return {
      targetId: commentId,
      targetProfileId: row.profileId,
      subjectUserId:
        row.authorUserId ?? row.linkedUserId ?? `imported:${commentId}`,
    };
  }

  /** A member page the reporter can see, at least by name. */
  private async pageTarget(
    writer: CommentWriter,
    slug: string | undefined,
  ): Promise<ReportTarget> {
    if (slug === undefined) {
      throw new BadRequestException(REPORT_TARGET_MISSING);
    }
    let found: Awaited<ReturnType<MembersService['findVisible']>>;
    try {
      found = await this.members.findVisible(slug, writer);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException(REPORT_PAGE_NOT_FOUND);
      }
      throw error;
    }
    const { profile } = found;
    if (profile.ownerUserId === writer.userId) {
      throw new ForbiddenException(REPORT_OWN_CONTENT);
    }
    const id = String(profile._id);
    return {
      targetId: id,
      targetProfileId: profile._id,
      subjectUserId: profile.ownerUserId ?? `imported-page:${id}`,
    };
  }
}
