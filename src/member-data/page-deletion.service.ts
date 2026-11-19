import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model, Types } from 'mongoose';
import { accountDeletedRows } from '../anchoring/account-deletion-record';
import { ConnectionRecords } from '../connections/connection-records.service';
import { inTransaction } from '../db/transactions';
import {
  Comment,
  type CommentDocument,
} from '../social/schemas/comment.schema';
import {
  CommentVersion,
  type CommentVersionDocument,
} from '../social/schemas/comment-version.schema';
import {
  AccountDeletion,
  type AccountDeletionDocument,
} from './schemas/account-deletion.schema';
import {
  gateWrite,
  UserWriteGate,
  type UserWriteGateDocument,
  writeGateId,
} from './schemas/user-write-gate.schema';
import {
  NotificationQueueRow,
  type NotificationQueueDocument,
} from '../member-notifications/schemas/notification-queue.schema';
import { cleanReason } from '../members/admin/admin-members.service';
import { ModerationLogService } from '../moderation/moderation-log.service';
import {
  type DeletionSource,
  type ProfileDeletion,
  type ProfileReviewStatus,
  SLUG_PATTERN,
  SocialProfile,
  type SocialProfileDocument,
} from '../social/schemas/social-profile.schema';
import {
  ALREADY_PURGED,
  CONFIRM_MISMATCH,
  DELETED_PAGE_SIZE,
  DELETION_DISCLOSURE,
  NOT_DELETED,
  OWN_PAGE_RESTORE,
  PAGE_ALREADY_DELETED,
  PAGE_BUSY,
  PAGE_CHANGED,
  PAGE_NOT_FOUND,
  purgeAfterOf,
  UNDO_EXPIRED,
  UNDO_NOT_YOURS,
  undoUntilOf,
  WEBHOOK_ACTOR,
} from './member-data.constants';

interface PageRow {
  _id: Types.ObjectId;
  slug: string;
  displayName: string;
  ownerUserId?: string;
  reviewStatus?: ProfileReviewStatus;
  deletedAt?: Date;
  deletion?: ProfileDeletion;
}

const PAGE_FIELDS = {
  slug: 1,
  displayName: 1,
  ownerUserId: 1,
  reviewStatus: 1,
  deletedAt: 1,
  deletion: 1,
};

/** What the member's "Your data" area shows. */
export interface MyDataStatus {
  page:
    | null
    | {
        slug: string;
        displayName: string;
        deleted: false;
      }
    | {
        slug: string;
        displayName: string;
        deleted: true;
        deletedAt: string;
        source: DeletionSource;
        /** Present while the member may still undo it themselves. */
        undoUntil?: string;
        purgeAfter: string;
      };
  /** The delete dialog's wording, from the server so it is one text. */
  disclosure: readonly string[];
}

export interface DeletedPageView {
  slug: string;
  displayName: string;
  source: DeletionSource;
  deletedAt: string;
  undoUntil?: string;
  purgeAfter: string;
  purgedAt?: string;
  /**
   * The owner's Clerk account was deleted (round 2, #6): a restore brings
   * the page back with no account behind it, and the account's purge still
   * removes it after five years.
   */
  ownerAccountGone: boolean;
}

function deletedView(row: PageRow): DeletedPageView {
  const deletion = row.deletion!;
  return {
    slug: row.slug,
    displayName: row.displayName,
    source: deletion.source,
    deletedAt: deletion.at.toISOString(),
    ...(deletion.undoUntil
      ? { undoUntil: deletion.undoUntil.toISOString() }
      : {}),
    purgeAfter: deletion.purgeAfter.toISOString(),
    ownerAccountGone: deletion.source === 'account-deleted',
    ...(deletion.purgedAt ? { purgedAt: deletion.purgedAt.toISOString() } : {}),
  };
}

/**
 * "Delete my page" (Chunk 17, plan §2b item 3): the page leaves the site at
 * once and ORG keeps everything for five years (D22).
 *
 * Deleting sets `deletedAt`, which every surface already treats as gone:
 * `decideProfileAccess` answers 404 to everyone, the owner and admins too;
 * the directory, search scope, comment author names, notification targets
 * and links all check it. Nothing is removed from the database; the
 * admin-removal state (`reviewStatus`, `removal`) is left exactly as it was,
 * so an undo brings back the page as it stood, removed by an admin included.
 *
 * Every change is one transaction with its moderation-log entry (the Chunk
 * 11/12 pattern), so the log says exactly what happened.
 */
@Injectable()
export class PageDeletionService {
  private readonly logger = new Logger(PageDeletionService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
    @InjectModel(NotificationQueueRow.name)
    private readonly queueModel: Model<NotificationQueueDocument>,
    private readonly log: ModerationLogService,
    @InjectModel(AccountDeletion.name)
    private readonly accountModel: Model<AccountDeletionDocument>,
    @InjectModel(Comment.name)
    private readonly commentModel: Model<CommentDocument>,
    @InjectModel(CommentVersion.name)
    private readonly commentVersionModel: Model<CommentVersionDocument>,
    @InjectModel(UserWriteGate.name)
    private readonly gateModel: Model<UserWriteGateDocument>,
    private readonly connections: ConnectionRecords,
  ) {}

  private ownPage(userId: string, session?: ClientSession) {
    const query = this.profileModel
      .findOne({ ownerUserId: userId })
      .select(PAGE_FIELDS);
    if (session) query.session(session);
    return query.lean().exec() as unknown as Promise<PageRow | null>;
  }

  /** The member's own page, deleted or not, and the dialog's wording. */
  async status(userId: string, now = new Date()): Promise<MyDataStatus> {
    const page = await this.ownPage(userId);
    if (!page || page.reviewStatus === 'claiming') {
      return { page: null, disclosure: DELETION_DISCLOSURE };
    }
    if (!page.deletedAt || !page.deletion) {
      return {
        page: {
          slug: page.slug,
          displayName: page.displayName,
          deleted: false,
        },
        disclosure: DELETION_DISCLOSURE,
      };
    }
    const { deletion } = page;
    const canUndo =
      deletion.source === 'member' &&
      !deletion.purgedAt &&
      deletion.undoUntil !== undefined &&
      deletion.undoUntil > now;
    return {
      page: {
        slug: page.slug,
        displayName: page.displayName,
        deleted: true,
        deletedAt: deletion.at.toISOString(),
        source: deletion.source,
        ...(canUndo ? { undoUntil: deletion.undoUntil!.toISOString() } : {}),
        purgeAfter: deletion.purgeAfter.toISOString(),
      },
      disclosure: DELETION_DISCLOSURE,
    };
  }

  /**
   * The member deletes their own page. They confirm by typing its address
   * (no re-authentication: the session token is already fresh, and Clerk's
   * step-up needs a setting the test instance does not have).
   *
   * @throws BadRequestException when the typed address does not match
   * @throws NotFoundException without a page; ConflictException when it is
   *   already deleted or still being joined
   */
  async deleteOwn(userId: string, confirm: string, now = new Date()) {
    const result = await inTransaction(this.connection, async (session) => {
      const page = await this.ownPage(userId, session);
      if (!page) throw new NotFoundException(PAGE_NOT_FOUND);
      if (page.reviewStatus === 'claiming') {
        throw new ConflictException(PAGE_BUSY);
      }
      if (page.deletedAt) throw new ConflictException(PAGE_ALREADY_DELETED);
      if (confirm.trim().toLowerCase() !== page.slug) {
        throw new BadRequestException(CONFIRM_MISMATCH);
      }
      const deletion: ProfileDeletion = {
        at: now,
        source: 'member',
        undoUntil: undoUntilOf(now),
        purgeAfter: purgeAfterOf(now),
      };
      await this.change(
        page,
        { deletedAt: { $exists: false } },
        { $set: { deletedAt: now, deletion } },
        session,
      );
      await this.record(
        userId,
        'page.deleted',
        page,
        'The member deleted their page.',
        session,
      );
      // Their requests and connections end with the page (Chunk 18); an
      // undo brings the page back, not the connections.
      await this.connections.endAllFor(userId, now, session);
      return { page, deletion };
    });
    await this.quietNotifications(result.page._id);
    return {
      deleted: true as const,
      undoUntil: result.deletion.undoUntil!.toISOString(),
      purgeAfter: result.deletion.purgeAfter.toISOString(),
    };
  }

  /**
   * The member brings their page back inside the undo window.
   *
   * @throws ConflictException when it is not deleted; ForbiddenException
   *   when the window has passed or the account deletion removed it
   */
  async undoOwn(userId: string, now = new Date()) {
    await inTransaction(this.connection, async (session) => {
      const page = await this.ownPage(userId, session);
      if (!page) throw new NotFoundException(PAGE_NOT_FOUND);
      const deletion = page.deletion;
      if (!page.deletedAt || !deletion) {
        throw new ConflictException(NOT_DELETED);
      }
      if (deletion.purgedAt || deletion.purgeStartedAt) {
        throw new ForbiddenException(ALREADY_PURGED);
      }
      if (deletion.source !== 'member') {
        throw new ForbiddenException(UNDO_NOT_YOURS);
      }
      if (!deletion.undoUntil || deletion.undoUntil <= now) {
        throw new ForbiddenException(UNDO_EXPIRED);
      }
      await this.restore(page, now, session);
      await this.record(
        userId,
        'page.deletion-undone',
        page,
        'The member brought their page back.',
        session,
      );
    });
    return { deleted: false as const };
  }

  /**
   * The member's Clerk account was deleted (verified `user.deleted` webhook).
   * Hides the page exactly as "Delete my page" does, with no undo for the
   * member (the account is gone); an admin can still restore it. Idempotent:
   * a redelivery, or an account whose page is already deleted, changes
   * nothing but the source, and the five-year clock keeps its first start.
   *
   * @returns what happened, for the webhook's log line
   */
  async accountDeleted(
    userId: string,
    now = new Date(),
  ): Promise<'no-page' | 'deleted' | 'already'> {
    const outcome = await inTransaction(this.connection, async (session) => {
      // The account's write gate first (round 9, F2): a comment written
      // after this transaction's snapshot makes it retry and see the row; one
      // written while it is open waits, then sees the deletion and is refused.
      await this.gateModel
        .updateOne({ _id: writeGateId(userId) }, gateWrite(now), {
          upsert: true,
          session,
        })
        .exec();
      const page = await this.ownPage(userId, session);
      // Requests and connections end with the account (Chunk 18).
      await this.connections.endAllFor(userId, now, session);
      // The account's own clock (review #6), with or without a page;
      // $setOnInsert keeps the first delivery's time on a redelivery.
      const known = await this.accountModel
        .findOne({ userId })
        .select({ _id: 1 })
        .session(session)
        .lean()
        .exec();
      const inserted = await this.accountModel
        .updateOne(
          { userId },
          {
            $setOnInsert: {
              userId,
              at: now,
              purgeAfter: purgeAfterOf(now),
              ...(page ? { profileId: page._id } : {}),
            },
          },
          { upsert: true, session },
        )
        .exec();
      if (inserted.upsertedCount === 1) {
        await this.recordDeletion(
          inserted.upsertedId as Types.ObjectId,
          userId,
          now,
          session,
        );
      }
      if (!page) return { state: 'no-page' as const };
      // The account was recorded already (a redelivery, or a page an admin
      // restored since): the page clock is left alone (round 3, L-2).
      if (known) return { state: 'already' as const };
      const at = page.deletion?.at ?? page.deletedAt ?? now;
      const deletion: ProfileDeletion = {
        at,
        source: 'account-deleted',
        purgeAfter: page.deletion?.purgeAfter ?? purgeAfterOf(at),
        ...(page.deletion?.purgedAt
          ? { purgedAt: page.deletion.purgedAt }
          : {}),
        ...(page.deletion?.purgeStartedAt
          ? { purgeStartedAt: page.deletion.purgeStartedAt }
          : {}),
      };
      await this.change(
        page,
        page.deletedAt
          ? { deletedAt: page.deletedAt }
          : { deletedAt: { $exists: false } },
        { $set: { deletedAt: page.deletedAt ?? now, deletion } },
        session,
      );
      await this.record(
        WEBHOOK_ACTOR,
        'page.account-deleted',
        page,
        'The member’s account was deleted, so their page was taken off the site.',
        session,
      );
      return { state: 'deleted' as const, page };
    });
    if (outcome.state === 'deleted') {
      await this.quietNotifications(outcome.page._id, userId);
    }
    return outcome.state;
  }

  /**
   * The anchored account-deletion record (Chunk 17 review round 4, #2),
   * only when the account row is first inserted: the row's id, the time and
   * the ids of the comments the account had authored, never the Clerk id.
   * Five years later the purge's redaction records stand on it.
   */
  private async recordDeletion(
    accountId: Types.ObjectId,
    userId: string,
    now: Date,
    session: ClientSession,
  ) {
    const authored = (await this.commentModel
      .find({ authorUserId: userId })
      .select({ commentId: 1 })
      .session(session)
      .lean()
      .exec()) as Array<{ commentId: string }>;
    await this.commentVersionModel.create(
      accountDeletedRows(
        accountId,
        now,
        authored.map((row) => row.commentId),
      ),
      { session, ordered: true },
    );
  }

  /** Deleted pages, the next due for the purge first (admins only). */
  async list(page: number) {
    const rows = (await this.profileModel
      .find({ deletion: { $exists: true } })
      .select({ ...PAGE_FIELDS })
      .sort({ 'deletion.purgeAfter': 1, _id: 1 })
      .skip((page - 1) * DELETED_PAGE_SIZE)
      .limit(DELETED_PAGE_SIZE + 1)
      .lean()
      .exec()) as unknown as PageRow[];
    return {
      pages: rows.slice(0, DELETED_PAGE_SIZE).map(deletedView),
      hasMore: rows.length > DELETED_PAGE_SIZE,
    };
  }

  /**
   * An admin brings a deleted page back, whoever deleted it, until the
   * purge has run. Not their own page: another admin does that (the Chunk
   * 12 rule for every page decision).
   */
  async adminRestore(
    adminId: string,
    rawSlug: string,
    rawReason: string,
    now = new Date(),
  ) {
    const reason = cleanReason(rawReason);
    const slug = rawSlug.trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) throw new NotFoundException(NOT_DELETED);
    let ownerAccountGone = false;
    await inTransaction(this.connection, async (session) => {
      const page = (await this.profileModel
        .findOne({ slug, deletion: { $exists: true } })
        .select(PAGE_FIELDS)
        .session(session)
        .lean()
        .exec()) as unknown as PageRow | null;
      if (!page || !page.deletedAt) throw new NotFoundException(NOT_DELETED);
      // Once the five years are up the purge may already be at work on it.
      if (
        page.deletion!.purgedAt ||
        page.deletion!.purgeStartedAt ||
        page.deletion!.purgeAfter <= now
      ) {
        throw new ConflictException(ALREADY_PURGED);
      }
      if (page.ownerUserId === adminId) {
        throw new ForbiddenException(OWN_PAGE_RESTORE);
      }
      ownerAccountGone = page.deletion!.source === 'account-deleted';
      await this.restore(page, now, session);
      await this.record(
        adminId,
        'page.deletion-restored',
        page,
        reason,
        session,
      );
    });
    return { restored: true as const, ownerAccountGone };
  }

  /** Never once the five years are up: the purge owns the page then. */
  private async restore(page: PageRow, now: Date, session: ClientSession) {
    await this.change(
      page,
      {
        deletedAt: page.deletedAt,
        'deletion.purgedAt': { $exists: false },
        'deletion.purgeStartedAt': { $exists: false },
        'deletion.purgeAfter': { $gt: now },
      },
      { $unset: { deletedAt: 1, deletion: 1 } },
      session,
    );
  }

  /** The conditional write; a page that moved meanwhile is a 409. */
  private async change(
    page: PageRow,
    expected: Record<string, unknown>,
    update: Record<string, unknown>,
    session: ClientSession,
  ) {
    const result = await this.profileModel
      .updateOne({ _id: page._id, ...expected }, update, { session })
      .exec();
    if (result.modifiedCount !== 1) throw new ConflictException(PAGE_CHANGED);
  }

  private async record(
    actor: string,
    action: string,
    page: PageRow,
    reason: string,
    session: ClientSession,
  ) {
    await this.log.record(
      {
        actorUserId: actor,
        action,
        targetType: 'member-page',
        targetId: String(page._id),
        reason,
        details: {
          slug: page.slug,
          ...(page.ownerUserId ? { ownerUserId: page.ownerUserId } : {}),
        },
      },
      session,
    );
  }

  /**
   * Emails still waiting about the page, or (account gone) to its member,
   * are withdrawn. The sender re-checks visibility anyway (Chunk 14), so a
   * failure here is logged and the deletion stands.
   */
  private async quietNotifications(profileId: Types.ObjectId, userId?: string) {
    try {
      await this.queueModel
        .updateMany(
          {
            status: 'queued',
            $or: [
              { 'refs.profileId': profileId },
              ...(userId ? [{ userId }, { actorUserId: userId }] : []),
            ],
          },
          { $set: { status: 'skipped', outcome: 'page-deleted' } },
        )
        .exec();
    } catch (error) {
      this.logger.warn(
        `Withdrawing emails about a deleted page failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
