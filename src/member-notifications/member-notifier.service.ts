import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import { utcDay } from '../moderation/report-quota.store';
import { NotificationDispatcher } from './notification-dispatcher.service';
import {
  CATEGORY_OF,
  deliveryFor,
  NO_LONGER_VISIBLE,
  type NotificationKind,
} from './notification-kinds';
import { NotificationPrefsService } from './notification-prefs.service';
import {
  ADMINS_RECIPIENT,
  NotificationQueueRow,
  type NotificationQueueDocument,
  QUEUE_KEEP_DAYS,
} from './schemas/notification-queue.schema';

const DAY_MS = 24 * 60 * 60_000;

type Refs = NotificationQueueRow['refs'];

/** The admin notices: what the admins' inbox says, by email too. */
export type AdminNoticeKind =
  | 'admin-page-submitted'
  | 'admin-eam-request'
  | 'admin-report'
  | 'admin-claim-requested';

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Where the members area says "tell them" (Chunk 14). Each method is called
 * AFTER the action it reports has committed, and never fails it: a
 * notification that cannot be queued is logged and dropped.
 *
 * Rules that hold for every event:
 * - nobody is told about their own action;
 * - an imported comment's Pages author (no account) is never a reader;
 * - the reader's settings decide digest, immediate or nothing, now; they are
 *   checked again when the email is sent;
 * - each event is queued once per reader (a `dedupeKey`), so a retried or
 *   doubled call does not double the email.
 */
@Injectable()
export class MemberNotifier {
  private readonly logger = new Logger(MemberNotifier.name);

  constructor(
    @InjectModel(NotificationQueueRow.name)
    private readonly queueModel: Model<NotificationQueueDocument>,
    private readonly prefs: NotificationPrefsService,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  /**
   * A comment or reply was posted: the page owner hears of it, and for a
   * reply so does the author of the comment it answers (once, as a reply,
   * when that is the owner).
   */
  async commentPosted(event: {
    commentId: string;
    actorUserId: string;
    profileId: Types.ObjectId;
    tabId?: string;
    pageOwnerUserId?: string;
    parentAuthorUserId?: string;
  }) {
    const refs: Refs = {
      commentId: event.commentId,
      profileId: event.profileId,
      ...(event.tabId !== undefined ? { tabId: event.tabId } : {}),
    };
    if (event.parentAuthorUserId) {
      await this.queue(event.parentAuthorUserId, 'reply', refs, {
        actorUserId: event.actorUserId,
        dedupeKey: `reply:${event.commentId}:${event.parentAuthorUserId}`,
      });
    }
    if (
      event.pageOwnerUserId &&
      event.pageOwnerUserId !== event.parentAuthorUserId
    ) {
      await this.queue(event.pageOwnerUserId, 'comment-on-page', refs, {
        actorUserId: event.actorUserId,
        dedupeKey: `comment-on-page:${event.commentId}:${event.pageOwnerUserId}`,
      });
    }
  }

  /** A rewording was suggested on the owner's belief. */
  async suggestionPosted(event: {
    commentId: string;
    actorUserId: string;
    ownerUserId?: string;
  }) {
    if (!event.ownerUserId) return;
    await this.queue(
      event.ownerUserId,
      'suggestion-posted',
      { commentId: event.commentId },
      {
        actorUserId: event.actorUserId,
        dedupeKey: `suggestion-posted:${event.commentId}`,
      },
    );
  }

  /** The owner decided on a suggestion; its author hears of it once. */
  async suggestionDecided(event: {
    commentId: string;
    actorUserId: string;
    suggesterUserId?: string;
  }) {
    if (!event.suggesterUserId) return;
    await this.queue(
      event.suggesterUserId,
      'suggestion-decided',
      { commentId: event.commentId },
      {
        actorUserId: event.actorUserId,
        dedupeKey: `suggestion-decided:${event.commentId}`,
      },
    );
  }

  /**
   * A belief's current wording reached the "agreed by 2 or more" list. Once
   * per wording: a new wording that gets there again is news again.
   */
  async beliefAgreed(event: {
    profileId: Types.ObjectId;
    tabId: string;
    textSeq: number;
    ownerUserId?: string;
    actorUserId: string;
  }) {
    if (!event.ownerUserId) return;
    await this.queue(
      event.ownerUserId,
      'belief-agreed',
      { profileId: event.profileId, tabId: event.tabId },
      {
        actorUserId: event.actorUserId,
        dedupeKey: `belief-agreed:${event.tabId}:${event.textSeq}`,
      },
    );
  }

  /** A claim was approved or rejected (by an admin, or by the site). */
  async claimDecided(event: {
    claimId: string;
    claimantUserId: string;
    actorUserId: string;
    profileId: Types.ObjectId;
    approved: boolean;
  }) {
    await this.queue(
      event.claimantUserId,
      event.approved ? 'claim-approved' : 'claim-rejected',
      { claimId: event.claimId, profileId: event.profileId },
      {
        actorUserId: event.actorUserId,
        dedupeKey: `claim-decided:${event.claimId}`,
      },
    );
  }

  /** A moderator hid, removed or restored a comment. Every action counts. */
  async commentModerated(event: {
    commentId: string;
    authorUserId?: string;
    actorUserId: string;
    state: 'hidden' | 'removed' | null;
  }) {
    if (!event.authorUserId) return;
    const kind: NotificationKind =
      event.state === 'hidden'
        ? 'comment-hidden'
        : event.state === 'removed'
          ? 'comment-removed'
          : 'comment-restored';
    await this.queue(
      event.authorUserId,
      kind,
      { commentId: event.commentId },
      { actorUserId: event.actorUserId },
    );
  }

  /**
   * A member sent another a connection request (Chunk 18). At most one
   * email per sender, recipient and UTC day, so sending and withdrawing over
   * and over cannot flood the recipient. The note is never in it.
   */
  async connectionRequested(event: {
    connectionId: string;
    fromUserId: string;
    toUserId: string;
    at: Date;
  }) {
    await this.queue(
      event.toUserId,
      'connection-requested',
      { connectionId: event.connectionId },
      {
        actorUserId: event.fromUserId,
        dedupeKey: `connection-requested:${event.fromUserId}:${event.toUserId}:${utcDay(event.at)}`,
        // A request withdrawn and sent again the same day: the one email
        // still waiting now points at the live request (review round 3).
        latestRefs: true,
      },
    );
  }

  /** The recipient accepted: the sender hears of it once. */
  async connectionAccepted(event: {
    connectionId: string;
    fromUserId: string;
    acceptedBy: string;
    at: Date;
  }) {
    await this.queue(
      event.fromUserId,
      'connection-accepted',
      { connectionId: event.connectionId },
      {
        actorUserId: event.acceptedBy,
        dedupeKey: `connection-accepted:${event.connectionId}`,
      },
    );
  }

  /**
   * Something the admins should know about. One row for all admins, fanned
   * out to each admin by the next tick (reading the admin list is a Clerk
   * call, kept off the request). Never sent to the admin it is about, nor
   * to the admin who caused it.
   *
   * @param once - one notice per this key (e.g. a reported target per day)
   */
  async adminNotice(event: {
    kind: AdminNoticeKind;
    subjectUserId: string;
    /** Who did it (the reporter of a report); also never sent to them. */
    actorUserId: string;
    once: string;
    refs?: Refs;
  }) {
    try {
      await this.queueModel.create({
        userId: ADMINS_RECIPIENT,
        category: CATEGORY_OF[event.kind],
        kind: event.kind,
        delivery: 'fanout',
        status: 'queued',
        subjectUserId: event.subjectUserId,
        actorUserId: event.actorUserId,
        refs: event.refs ?? {},
        dedupeKey: `admins:${event.once}`,
        attempts: 0,
        expiresAt: new Date(Date.now() + QUEUE_KEEP_DAYS * DAY_MS),
      });
      void this.dispatcher.kick();
    } catch (error) {
      if (isDuplicateKey(error)) return;
      this.logger.warn(
        `Could not queue an admin notice (${event.kind}): ${describe(error)}`,
      );
    }
  }

  /** The `once` key of a report notice: one per target per UTC day. */
  static reportOnce(targetType: string, targetId: string, now = new Date()) {
    return `report:${targetType}:${targetId}:${utcDay(now)}`;
  }

  private async queue(
    userId: string,
    kind: NotificationKind,
    refs: Refs,
    options: { actorUserId: string; dedupeKey?: string; latestRefs?: true },
  ) {
    if (userId === options.actorUserId || userId.startsWith('imported:')) {
      return;
    }
    try {
      const category = CATEGORY_OF[kind];
      const delivery = deliveryFor(category, await this.prefs.get(userId));
      if (!delivery) return;
      await this.queueModel.create({
        userId,
        category,
        kind,
        delivery,
        status: 'queued',
        actorUserId: options.actorUserId,
        refs,
        ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
        attempts: 0,
        expiresAt: new Date(Date.now() + QUEUE_KEEP_DAYS * DAY_MS),
      });
      if (delivery === 'immediate') void this.dispatcher.kick();
    } catch (error) {
      if (!isDuplicateKey(error)) {
        this.logger.warn(
          `Could not queue a notification (${kind}): ${describe(error)}`,
        );
        return;
      }
      if (options.latestRefs) {
        // The day's one email now points at the live request: while it still
        // waits, or after the digest dropped it as no longer visible (it was
        // never sent, so it is queued again). One already sent stays the
        // day's one (review round 4).
        try {
          await this.queueModel
            .updateOne(
              {
                dedupeKey: options.dedupeKey,
                $or: [
                  { status: 'queued' },
                  {
                    status: 'skipped',
                    outcome: NO_LONGER_VISIBLE,
                    sentAt: { $exists: false },
                  },
                ],
              },
              {
                $set: { refs, status: 'queued' },
                $unset: { outcome: 1 },
                $inc: { refsVersion: 1 },
              },
            )
            .exec();
        } catch (failure) {
          this.logger.warn(
            `Could not update a queued notification (${kind}): ${describe(failure)}`,
          );
        }
      }
    }
  }
}
