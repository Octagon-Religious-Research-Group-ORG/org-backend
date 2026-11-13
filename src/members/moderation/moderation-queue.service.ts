import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type Connection, Model, Types } from 'mongoose';
import { AdminInboxService } from '../../admin-inbox/admin-inbox.service';
import { inTransaction } from '../../db/transactions';
import { ModerationLogService } from '../../moderation/moderation-log.service';
import { ReportsStore } from '../../moderation/reports.store';
import {
  Report,
  type ReportDocument,
  type ReportReason,
  type ReportResolution,
  type ReportStatus,
  type ReportTargetType,
} from '../../moderation/schemas/report.schema';
import { CommentVersionsService } from '../../social/comment-versions.service';
import {
  BeliefTab,
  type BeliefTabDocument,
} from '../../social/schemas/belief-tab.schema';
import {
  Comment,
  type CommentDocument,
  type ModerationState,
} from '../../social/schemas/comment.schema';
import {
  SocialProfile,
  type SocialProfileDocument,
} from '../../social/schemas/social-profile.schema';
import { cleanReason } from '../admin/admin-members.service';
import { CommentAuthorsService } from '../comments/comment-authors.service';
import type { CommentAuthorView } from '../comments/comment-serializers';
import { COMMENT_TURN_STALE_MS, LISTED } from '../comments/comment-store';
import { ACCEPT_LOCK_STALE_MS } from '../comments/suggestions.service';
import { orgPageIdOfThread } from '../org-pages/org-page-targets';
import type { Viewer } from '../profile-access';

export const QUEUE_PAGE_SIZE = 20;
/** Reports listed per target; the count says how many there are. */
export const REPORTS_SHOWN_PER_TARGET = 20;

export const TARGET_NOT_FOUND = 'That comment does not exist.';
export const OWN_CONTENT =
  'Another admin must decide about reports on your own words or page.';
export const ALREADY_IN_STATE = 'The comment is already like that.';
export const NOT_MODERATED =
  'A moderator has not hidden or removed that comment.';
export const COMMENT_BUSY_NOW =
  'The comment is being saved or changed right now. Please try again in a moment.';
export const NO_OPEN_REPORTS = 'There are no open reports on that.';

/** What a moderator can do to a comment. */
export type CommentAction = 'hide' | 'remove' | 'restore';

const STATE_OF: Record<Exclude<CommentAction, 'restore'>, ModerationState> = {
  hide: 'hidden',
  remove: 'removed',
};

/** One report as an admin sees it. The reporter is admins-only. */
export interface ReportView {
  reason: ReportReason;
  note?: string;
  reporterUserId: string;
  reporter: CommentAuthorView;
  reportedAt: string;
  resolution?: ReportResolution;
  resolvedBy?: string;
  resolvedAt?: string;
}

/** Where a reported comment sits. */
export type CommentPlace =
  | {
      kind: 'member-page';
      slug?: string;
      displayName?: string;
      /** A belief tab; absent for the page's own thread. */
      belief?: { tabId: string; title: string; removed: boolean };
    }
  | { kind: 'org-page'; pageId: string };

export interface ReportedCommentView {
  commentId: string;
  /** Hidden from the reported member's view? `null`: shown. */
  moderation: ModerationState | null;
  removedByAuthor: boolean;
  kind: 'comment' | 'suggestion';
  source: 'imported' | 'member';
  author: CommentAuthorView;
  /** Admins see the account id; absent for an unlinked imported comment. */
  authorUserId?: string;
  importedName?: string;
  /** The current text: always, whatever its state (admins only). */
  body: string;
  proposedText?: string;
  stance?: 'agree' | 'disagree';
  postedAt: string;
  place: CommentPlace;
}

export interface ReportedPageView {
  slug: string;
  displayName: string;
  reviewStatus: string;
  ownerUserId?: string;
}

export interface QueueEntry {
  targetType: ReportTargetType;
  targetId: string;
  /** Reports on it in this list (open, or closed). */
  count: number;
  firstReportedAt: string;
  lastReportedAt: string;
  reports: ReportView[];
  /** The admin asking wrote it or owns it: they may not act on it. */
  ownContent: boolean;
  comment?: ReportedCommentView;
  page?: ReportedPageView;
  /** The comment or page no longer exists at all. */
  missing?: boolean;
}

interface Group {
  _id: { targetType: ReportTargetType; targetId: string };
  count: number;
  first: Date;
  last: Date;
  reports: Array<{
    reason: ReportReason;
    note?: string;
    reporterUserId: string;
    createdAt: Date;
    resolution?: ReportResolution;
    resolvedBy?: string;
    resolvedAt?: Date;
  }>;
}

interface CommentRowForQueue {
  commentId: string;
  profileId: Types.ObjectId;
  tabId?: string;
  parentCommentId?: string;
  authorUserId?: string;
  legacyAuthorName?: string;
  linkedUserId?: string;
  writtenAsAdmin?: boolean;
  body: string;
  source: 'migrated' | 'native';
  kind?: 'comment' | 'suggestion';
  stance?: 'agree' | 'disagree';
  suggestion?: { proposedText: string };
  moderation?: ModerationState;
  removedAt?: Date;
  createdAt: Date;
}

interface PageRow {
  _id: Types.ObjectId;
  slug: string;
  displayName: string;
  reviewStatus?: string;
  ownerUserId?: string;
}

const ADMIN_READER: Viewer = { kind: 'signed-in', isAdmin: true };

/**
 * The moderation queue of the admin dashboard (Chunk 13).
 *
 * - The queue lists reported comments and member pages, one entry per
 *   target with all its reports, open ones oldest first, or closed ones
 *   most recent first.
 * - A comment can be hidden, removed or restored; any target's reports can
 *   be dismissed. Each action closes ALL the target's open reports, marks
 *   its inbox notice handled and writes the moderation log, in one
 *   transaction (Chunk 11 pattern).
 * - A member page is taken off through the Members section (Chunk 12), which
 *   closes its reports in the same transaction; the queue links there.
 * - An admin never acts on reports about their own words or page.
 */
@Injectable()
export class ModerationQueueService {
  constructor(
    @InjectModel(Report.name)
    private readonly reportModel: Model<ReportDocument>,
    @InjectModel(Comment.name)
    private readonly commentModel: Model<CommentDocument>,
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    @InjectModel(BeliefTab.name)
    private readonly tabModel: Model<BeliefTabDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly versions: CommentVersionsService,
    private readonly authors: CommentAuthorsService,
    private readonly reports: ReportsStore,
    private readonly inbox: AdminInboxService,
    private readonly log: ModerationLogService,
  ) {}

  async queue(
    adminId: string,
    status: ReportStatus,
    page: number,
  ): Promise<{ entries: QueueEntry[]; hasMore: boolean }> {
    const groups = await this.reportModel
      .aggregate<Group>([
        { $match: { status } },
        { $sort: { targetType: 1, targetId: 1, createdAt: 1 } },
        {
          $group: {
            _id: { targetType: '$targetType', targetId: '$targetId' },
            count: { $sum: 1 },
            first: { $min: '$createdAt' },
            last: {
              $max: status === 'open' ? '$createdAt' : '$resolvedAt',
            },
            reports: {
              $push: {
                reason: '$reason',
                note: '$note',
                reporterUserId: '$reporterUserId',
                createdAt: '$createdAt',
                resolution: '$resolution',
                resolvedBy: '$resolvedBy',
                resolvedAt: '$resolvedAt',
              },
            },
          },
        },
        {
          $sort:
            status === 'open'
              ? { first: 1, '_id.targetId': 1 }
              : { last: -1, '_id.targetId': 1 },
        },
        { $skip: (page - 1) * QUEUE_PAGE_SIZE },
        { $limit: QUEUE_PAGE_SIZE + 1 },
        {
          $project: {
            count: 1,
            first: 1,
            last: 1,
            reports: { $slice: ['$reports', REPORTS_SHOWN_PER_TARGET] },
          },
        },
      ])
      .exec();
    const shown = groups.slice(0, QUEUE_PAGE_SIZE);
    const commentIds = shown
      .filter((group) => group._id.targetType === 'comment')
      .map((group) => group._id.targetId);
    const pageIds = shown
      .filter((group) => group._id.targetType === 'member-page')
      .flatMap((group) =>
        Types.ObjectId.isValid(group._id.targetId)
          ? [new Types.ObjectId(group._id.targetId)]
          : [],
      );
    const comments = await this.commentViews(commentIds);
    const pages = await this.pageRows(pageIds);
    const reporterOf = await this.authors.resolve(
      shown.flatMap((group) => group.reports.map((r) => r.reporterUserId)),
      ADMIN_READER,
    );
    return {
      entries: shown.map((group) => {
        const { targetType, targetId } = group._id;
        const comment =
          targetType === 'comment' ? comments.get(targetId) : undefined;
        const pageRow =
          targetType === 'member-page' ? pages.get(targetId) : undefined;
        const ownContent = comment
          ? comment.authorUserId === adminId
          : pageRow?.ownerUserId === adminId;
        return {
          targetType,
          targetId,
          count: group.count,
          firstReportedAt: group.first.toISOString(),
          lastReportedAt: (group.last ?? group.first).toISOString(),
          reports: group.reports.map((report) => ({
            reason: report.reason,
            ...(report.note ? { note: report.note } : {}),
            reporterUserId: report.reporterUserId,
            reporter: reporterOf(report.reporterUserId),
            reportedAt: report.createdAt.toISOString(),
            ...(report.resolution ? { resolution: report.resolution } : {}),
            ...(report.resolvedBy ? { resolvedBy: report.resolvedBy } : {}),
            ...(report.resolvedAt
              ? { resolvedAt: report.resolvedAt.toISOString() }
              : {}),
          })),
          ownContent,
          ...(comment ? { comment: comment.view } : {}),
          ...(pageRow
            ? {
                page: {
                  slug: pageRow.slug,
                  displayName: pageRow.displayName,
                  reviewStatus: pageRow.reviewStatus ?? 'approved',
                  ...(pageRow.ownerUserId
                    ? { ownerUserId: pageRow.ownerUserId }
                    : {}),
                },
              }
            : {}),
          ...(!comment && !pageRow ? { missing: true } : {}),
        };
      }),
      hasMore: groups.length > QUEUE_PAGE_SIZE,
    };
  }

  /** The reported comments as an admin reads them, with their place. */
  private async commentViews(commentIds: string[]) {
    const out = new Map<
      string,
      { view: ReportedCommentView; authorUserId?: string }
    >();
    if (commentIds.length === 0) return out;
    const rows = (await this.commentModel
      .find({ commentId: { $in: commentIds }, ...LISTED })
      .lean()
      .exec()) as unknown as CommentRowForQueue[];
    const heads = await this.versions.heads(
      rows
        .filter((row) => row.source === 'native' && row.kind !== 'suggestion')
        .map((row) => row.commentId),
    );
    const authorIds = rows.flatMap((row) =>
      row.authorUserId
        ? [row.authorUserId]
        : row.linkedUserId
          ? [row.linkedUserId]
          : [],
    );
    const authorOf = await this.authors.resolve(authorIds, ADMIN_READER);
    const memberPages = await this.pageRows(
      rows
        .filter((row) => orgPageIdOfThread(row.tabId) === undefined)
        .map((row) => row.profileId),
    );
    const tabIds = rows.flatMap((row) =>
      row.tabId && orgPageIdOfThread(row.tabId) === undefined
        ? [row.tabId]
        : [],
    );
    const tabs =
      tabIds.length === 0
        ? []
        : ((await this.tabModel
            .find({ tabId: { $in: tabIds } })
            .select({ tabId: 1, title: 1, removedAt: 1 })
            .lean()
            .exec()) as Array<{
            tabId: string;
            title: string;
            removedAt?: Date;
          }>);
    const tabOf = new Map(tabs.map((tab) => [tab.tabId, tab]));
    for (const row of rows) {
      const owner = row.authorUserId ?? row.linkedUserId;
      const orgPageId = orgPageIdOfThread(row.tabId);
      let place: CommentPlace;
      if (orgPageId !== undefined) {
        place = { kind: 'org-page', pageId: orgPageId };
      } else {
        const pageRow = memberPages.get(String(row.profileId));
        const tab = row.tabId ? tabOf.get(row.tabId) : undefined;
        place = {
          kind: 'member-page',
          ...(pageRow
            ? { slug: pageRow.slug, displayName: pageRow.displayName }
            : {}),
          ...(tab
            ? {
                belief: {
                  tabId: tab.tabId,
                  title: tab.title,
                  removed: Boolean(tab.removedAt),
                },
              }
            : {}),
        };
      }
      const imported = row.source === 'migrated';
      out.set(row.commentId, {
        authorUserId: owner,
        view: {
          commentId: row.commentId,
          moderation: row.moderation ?? null,
          removedByAuthor: Boolean(row.removedAt),
          kind: row.kind ?? 'comment',
          source: imported ? 'imported' : 'member',
          author: owner
            ? authorOf(owner, row.writtenAsAdmin)
            : { kind: 'imported', name: String(row.legacyAuthorName) },
          ...(owner ? { authorUserId: owner } : {}),
          ...(imported ? { importedName: row.legacyAuthorName } : {}),
          body: heads.get(row.commentId)?.text ?? row.body,
          ...(row.suggestion
            ? { proposedText: row.suggestion.proposedText }
            : {}),
          ...(row.stance ? { stance: row.stance } : {}),
          postedAt: row.createdAt.toISOString(),
          place,
        },
      });
    }
    return out;
  }

  private async pageRows(ids: Types.ObjectId[]) {
    if (ids.length === 0) return new Map<string, PageRow>();
    const rows = (await this.profileModel
      .find({ _id: { $in: ids }, deletedAt: { $exists: false } })
      .select({ slug: 1, displayName: 1, reviewStatus: 1, ownerUserId: 1 })
      .lean()
      .exec()) as unknown as PageRow[];
    return new Map(rows.map((row) => [String(row._id), row]));
  }

  /**
   * Hides, removes or restores a comment, closing its open reports.
   *
   * - Hide and remove wait for an edit holding a turn, and for an accept of
   *   a suggestion in progress, so no new text lands under the decision.
   * - Hide ↔ remove is allowed (a change of mind); the same state twice, or
   *   restoring a comment that is shown, is a 409.
   *
   * @throws NotFoundException / ForbiddenException (own words) /
   *   ConflictException; BadRequestException for an empty reason
   */
  async moderateComment(
    adminId: string,
    commentId: string,
    action: CommentAction,
    rawReason: string,
  ) {
    const reason = cleanReason(rawReason);
    return inTransaction(this.connection, async (session) => {
      const row = (await this.commentModel
        .findOne({ commentId, ...LISTED })
        .session(session)
        .lean()
        .exec()) as unknown as CommentRowForQueue | null;
      if (!row) throw new NotFoundException(TARGET_NOT_FOUND);
      if (row.authorUserId === adminId || row.linkedUserId === adminId) {
        throw new ForbiddenException(OWN_CONTENT);
      }
      const before = row.moderation ?? null;
      let after: ModerationState | null;
      if (action === 'restore') {
        if (before === null) throw new ConflictException(NOT_MODERATED);
        after = null;
        const done = await this.commentModel
          .updateOne(
            { commentId, moderation: before },
            { $unset: { moderation: 1, moderatedAt: 1, moderatedBy: 1 } },
            { session },
          )
          .exec();
        if (done.modifiedCount !== 1) {
          throw new ConflictException(COMMENT_BUSY_NOW);
        }
      } else {
        after = STATE_OF[action];
        if (before === after) throw new ConflictException(ALREADY_IN_STATE);
        const now = Date.now();
        const done = await this.commentModel
          .updateOne(
            {
              commentId,
              moderation: before === null ? { $exists: false } : before,
              // No live edit turn and no live accept (see above).
              editTurns: {
                $not: {
                  $elemMatch: {
                    at: { $gte: new Date(now - COMMENT_TURN_STALE_MS) },
                  },
                },
              },
              $nor: [
                {
                  'suggestion.status': 'accepting',
                  'suggestion.lockedAt': {
                    $gte: new Date(now - ACCEPT_LOCK_STALE_MS),
                  },
                },
              ],
            },
            {
              $set: {
                moderation: after,
                moderatedAt: new Date(now),
                moderatedBy: adminId,
              },
            },
            { session },
          )
          .exec();
        if (done.modifiedCount !== 1) {
          throw new ConflictException(COMMENT_BUSY_NOW);
        }
      }
      const resolution: ReportResolution = after === null ? 'restored' : after;
      const closed = await this.closeReports(
        'comment',
        commentId,
        resolution,
        adminId,
        session,
      );
      await this.log.record(
        {
          actorUserId: adminId,
          action:
            after === null
              ? 'comment.restored'
              : after === 'hidden'
                ? 'comment.hidden'
                : 'comment.removed',
          targetType: 'comment',
          targetId: commentId,
          reason,
          details: {
            before: before ?? 'shown',
            reportsClosed: closed,
            profileId: String(row.profileId),
            ...(row.tabId ? { tabId: row.tabId } : {}),
            ...(row.authorUserId ? { authorUserId: row.authorUserId } : {}),
          },
        },
        session,
      );
      return { moderation: after, reportsClosed: closed };
    });
  }

  /**
   * Closes a target's open reports with nothing done.
   *
   * @throws NotFoundException for no open report on it /
   *   ForbiddenException for the admin's own words or page
   */
  async dismiss(
    adminId: string,
    targetType: ReportTargetType,
    targetId: string,
    rawReason: string,
  ) {
    const reason = cleanReason(rawReason);
    return inTransaction(this.connection, async (session) => {
      if (await this.isOwnContent(adminId, targetType, targetId, session)) {
        throw new ForbiddenException(OWN_CONTENT);
      }
      const closed = await this.closeReports(
        targetType,
        targetId,
        'dismissed',
        adminId,
        session,
      );
      if (closed === 0) throw new NotFoundException(NO_OPEN_REPORTS);
      await this.log.record(
        {
          actorUserId: adminId,
          action: 'reports.dismissed',
          targetType,
          targetId,
          reason,
          details: { reportsClosed: closed },
        },
        session,
      );
      return { dismissed: closed };
    });
  }

  private async isOwnContent(
    adminId: string,
    targetType: ReportTargetType,
    targetId: string,
    session: ClientSession,
  ) {
    if (targetType === 'comment') {
      const row = (await this.commentModel
        .findOne({ commentId: targetId })
        .select({ authorUserId: 1, linkedUserId: 1 })
        .session(session)
        .lean()
        .exec()) as { authorUserId?: string; linkedUserId?: string } | null;
      return row?.authorUserId === adminId || row?.linkedUserId === adminId;
    }
    if (!Types.ObjectId.isValid(targetId)) return false;
    const page = (await this.profileModel
      .findOne({ _id: new Types.ObjectId(targetId) })
      .select({ ownerUserId: 1 })
      .session(session)
      .lean()
      .exec()) as { ownerUserId?: string } | null;
    return page?.ownerUserId === adminId;
  }

  private async closeReports(
    targetType: ReportTargetType,
    targetId: string,
    resolution: ReportResolution,
    adminId: string,
    session: ClientSession,
  ) {
    const closed = await this.reports.resolveOpen(
      targetType,
      targetId,
      resolution,
      adminId,
      session,
    );
    await this.inbox.closeReportNotice(targetType, targetId, adminId, session);
    return closed;
  }
}
