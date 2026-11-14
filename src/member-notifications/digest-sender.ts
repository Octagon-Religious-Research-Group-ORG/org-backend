import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection, Model, Types } from 'mongoose';
import { inTransaction } from '../db/transactions';
import { utcDay } from '../moderation/report-quota.store';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailBudgetStore, nextUtcDay } from './email-budget.store';
import { readNotificationConfig } from './notification-config';
import { deliveryFor } from './notification-kinds';
import { composeEmail } from './notification-mail';
import { NotificationPrefsService } from './notification-prefs.service';
import {
  type Described,
  NotificationTargets,
  type Recipient,
} from './notification-targets.service';
import {
  NotificationDigestRow,
  type NotificationDigestDocument,
} from './schemas/notification-digest.schema';
import {
  NotificationQueueRow,
  type NotificationQueueDocument,
} from './schemas/notification-queue.schema';
import type { StoredEmail } from './schemas/stored-email.schema';
import {
  afterFailedSend,
  keyMayHaveExpired,
  sendKey,
  UNKNOWN_GIVE_UP,
} from './send-attempts';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** How long a tick holds a member's digest. */
export const DIGEST_LEASE_MS = 10 * MINUTE_MS;
/** Send attempts of one digest before its items wait for tomorrow. */
export const DIGEST_MAX_ATTEMPTS = 3;
/** Items in one digest at most; the rest goes in the next one. */
export const MAX_DIGEST_ITEMS = 100;
/** Members looked at per page of a pass. */
export const DIGEST_MEMBERS_PER_PASS = 200;
/** Pages of members per pass at most. */
export const DIGEST_PAGES_PER_PASS = 10;
/** Digest rows are kept this long. */
export const DIGEST_KEEP_DAYS = 30;

type DigestRow = NotificationDigestRow & { _id: Types.ObjectId };
type ItemRow = NotificationQueueRow & { _id: Types.ObjectId };

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

/** A digest item is due: no wait set, or its wait is over. */
function dueBy(now: Date) {
  return {
    $or: [
      { nextAttemptAt: { $exists: false } },
      { nextAttemptAt: { $lte: now } },
    ],
  };
}

/**
 * The daily digest (Chunk 14): one email per member per UTC day with what
 * queued for them since their last one.
 *
 * - **When:** from `DIGEST_HOUR_UTC` on, or at once for a member whose
 *   oldest waiting item is over a day old (the server slept through the
 *   hour: the catch-up).
 * - **Once:** the unique (userId, day) row is the claim. An unfinished row
 *   of ANY day (a tick that died, a failed or deferred send) is resumed
 *   before anything new, with its same items, its same stored body and its
 *   same Resend idempotency key, and moved to today (review L1, L3).
 * - **Keys:** only a definite refusal gets a new key; a send that may have
 *   happened is retried under the same one, and given up (never resent)
 *   once the key may have expired (review L2).
 * - **Budget:** digests stop short of the immediate reserve; a member who
 *   does not fit keeps their items for a later tick or day (oldest first).
 * - **Out of the way:** a member whose day is done has their remaining news
 *   moved to the next day, so they do not fill the next pass (review L4).
 * - **Marking:** the row and its items become `sent` in one transaction.
 */
@Injectable()
export class DigestSender {
  private readonly logger = new Logger(DigestSender.name);
  private readonly settings: ReturnType<typeof readNotificationConfig>;
  /** Members looked at per page; smaller in tests. */
  membersPerPass = DIGEST_MEMBERS_PER_PASS;

  constructor(
    @InjectModel(NotificationQueueRow.name)
    private readonly queueModel: Model<NotificationQueueDocument>,
    @InjectModel(NotificationDigestRow.name)
    private readonly digestModel: Model<NotificationDigestDocument>,
    @InjectConnection() private readonly connection: Connection,
    config: ConfigService,
    private readonly prefs: NotificationPrefsService,
    private readonly targets: NotificationTargets,
    private readonly budget: EmailBudgetStore,
    private readonly mail: NotificationsService,
  ) {
    this.settings = readNotificationConfig(config);
  }

  /** Digests that ran out of attempts since `since` (review L7). */
  failedSince(since: Date): Promise<number> {
    return this.digestModel
      .countDocuments({
        status: 'failed',
        attempts: { $gte: DIGEST_MAX_ATTEMPTS },
        updatedAt: { $gte: since },
      })
      .exec();
  }

  async run(now: Date) {
    const hourReached = now.getUTCHours() >= this.settings.digestHourUtc;
    // Before the hour, only the overdue (the catch-up).
    const upTo = hourReached ? now : new Date(now.getTime() - DAY_MS);
    const seen: string[] = [];
    for (let page = 0; page < DIGEST_PAGES_PER_PASS; page++) {
      const waiting = (await this.queueModel
        .aggregate([
          {
            $match: {
              status: 'queued',
              delivery: 'digest',
              createdAt: { $lte: upTo },
              userId: { $nin: seen },
              ...dueBy(now),
            },
          },
          { $group: { _id: '$userId', oldest: { $min: '$createdAt' } } },
          { $sort: { oldest: 1 } },
          { $limit: this.membersPerPass },
        ])
        .exec()) as Array<{ _id: string }>;
      if (waiting.length === 0) return;
      for (const { _id: userId } of waiting) {
        seen.push(userId);
        try {
          if ((await this.forMember(userId, now)) === 'budget') return;
        } catch (error) {
          this.logger.error(`A digest failed: ${describe(error)}`);
        }
      }
    }
  }

  /** Claims, builds (or replays) and sends one member's digest. */
  async forMember(
    userId: string,
    now: Date,
  ): Promise<'sent' | 'skipped' | 'budget' | 'failed'> {
    const claimed = await this.claim(userId, now);
    if (!claimed) return 'skipped';
    const { row, token } = claimed;
    const finish = (
      set: Record<string, unknown>,
      unset: Record<string, 1> = {},
    ) =>
      this.digestModel
        .updateOne(
          { _id: row._id, leaseToken: token },
          { $set: set, $unset: { ...unset, leaseUntil: 1, leaseToken: 1 } },
        )
        .exec();

    if (keyMayHaveExpired(row, now)) {
      await this.giveUp(row, finish);
      return 'failed';
    }
    let recipient: Recipient | undefined;
    try {
      recipient = await this.targets.recipient(userId);
    } catch (error) {
      this.logger.warn(`Could not read a reader's account: ${describe(error)}`);
      // Nothing was sent, so no key was used.
      const attempts = row.attempts + 1;
      await finish({ status: 'failed', attempts });
      if (attempts >= DIGEST_MAX_ATTEMPTS) {
        await this.moveOn(userId, now, row.itemIds);
      }
      return 'failed';
    }
    if (!recipient) {
      await this.drop(row.itemIds, 'account gone');
      await finish({ status: 'nothing' });
      await this.moveOn(userId, now);
      return 'skipped';
    }

    let email = row.email;
    let shownIds = row.shownIds;
    if (!email || !shownIds) {
      const built = await this.build(row, recipient);
      if (!built) {
        await finish({ status: 'nothing' });
        await this.moveOn(userId, now);
        return 'skipped';
      }
      ({ email, shownIds } = built);
    }
    if (!recipient.email) {
      await this.drop(shownIds, 'no verified address');
      await finish({ status: 'nothing' });
      await this.moveOn(userId, now);
      return 'skipped';
    }
    if (!(await this.budget.take('digest', now))) {
      await finish({ status: 'deferred', email, shownIds });
      return 'budget';
    }
    // Stored before the send, so a takeover replays this very body.
    await this.digestModel
      .updateOne(
        { _id: row._id, leaseToken: token },
        { $set: { email, shownIds } },
      )
      .exec();
    const result = await this.mail.sendNotice({
      to: recipient.email,
      subject: email.subject,
      lines: email.lines,
      headers: email.headers,
      idempotencyKey: sendKey('org-digest', row._id, row),
    });
    if (result !== 'sent') {
      const next = afterFailedSend(result, row, now, DIGEST_MAX_ATTEMPTS);
      await finish(
        { ...next.set, status: 'failed' },
        next.refused ? { ...next.unset, email: 1, shownIds: 1 } : next.unset,
      );
      if (next.final) {
        if (next.refused) await this.moveOn(userId, now, row.itemIds);
        else await this.drop(shownIds, UNKNOWN_GIVE_UP, 'failed');
      }
      return 'failed';
    }
    const sentAt = new Date();
    const ids = shownIds;
    await inTransaction(this.connection, async (session) => {
      await this.digestModel
        .updateOne(
          { _id: row._id, leaseToken: token },
          {
            $set: { status: 'sent', sentAt },
            $unset: { leaseUntil: 1, leaseToken: 1 },
          },
          { session },
        )
        .exec();
      await this.queueModel
        .updateMany(
          { _id: { $in: ids }, status: 'queued' },
          { $set: { status: 'sent', sentAt, digestId: row._id } },
          { session },
        )
        .exec();
    });
    await this.moveOn(userId, now);
    return 'sent';
  }

  /**
   * What the email says, from the row's items as the reader may see them
   * now. Items whose category or both channels are off are dropped; claim
   * and moderation news whose member now has immediate emails on goes that
   * way instead (review L8).
   *
   * @returns undefined when nothing is left to say
   */
  private async build(
    row: DigestRow,
    recipient: Recipient,
  ): Promise<{ email: StoredEmail; shownIds: Types.ObjectId[] } | undefined> {
    const items = (await this.queueModel
      .find({ _id: { $in: row.itemIds }, status: 'queued', delivery: 'digest' })
      .sort({ createdAt: 1 })
      .lean()
      .exec()) as unknown as ItemRow[];
    const prefs = await this.prefs.get(row.userId);
    const shown: Array<{ item: ItemRow; line: Described }> = [];
    for (const item of items) {
      const delivery = deliveryFor(item.category, prefs);
      if (!delivery) {
        await this.drop([item._id], 'turned off');
      } else if (delivery === 'immediate') {
        await this.queueModel
          .updateOne(
            { _id: item._id, status: 'queued' },
            { $set: { delivery: 'immediate' }, $unset: { nextAttemptAt: 1 } },
          )
          .exec();
      } else {
        const line = await this.targets.describe(item, recipient);
        if (line) shown.push({ item, line });
        else await this.drop([item._id], 'no longer visible');
      }
    }
    if (shown.length === 0) return undefined;
    return {
      email: composeEmail({
        items: shown.map(({ line }) => line),
        digest: true,
        userId: row.userId,
        scope: 'digest',
        signingKey: this.settings.signingKey,
        publicAppUrl: this.settings.publicAppUrl,
        publicApiUrl: this.settings.publicApiUrl,
      }),
      shownIds: shown.map(({ item }) => item._id),
    };
  }

  /** Gives up on a send whose key may have expired: never resent. */
  private async giveUp(
    row: DigestRow,
    finish: (set: Record<string, unknown>) => Promise<unknown>,
  ) {
    await finish({ status: 'failed', attempts: DIGEST_MAX_ATTEMPTS });
    await this.drop(row.shownIds ?? row.itemIds, UNKNOWN_GIVE_UP, 'failed');
  }

  private async drop(
    ids: Types.ObjectId[],
    outcome: string,
    status: 'skipped' | 'failed' = 'skipped',
  ) {
    await this.queueModel
      .updateMany(
        { _id: { $in: ids }, status: 'queued' },
        { $set: { status, outcome } },
      )
      .exec();
  }

  /**
   * The member's day is done: their remaining due news waits for the next
   * day, out of the way of the members still to send (review L4).
   */
  private async moveOn(userId: string, now: Date, ids?: Types.ObjectId[]) {
    await this.queueModel
      .updateMany(
        {
          userId,
          status: 'queued',
          delivery: 'digest',
          ...(ids ? { _id: { $in: ids } } : dueBy(now)),
        },
        { $set: { nextAttemptAt: nextUtcDay(now) } },
      )
      .exec();
  }

  /**
   * The member's digest to send: first an unfinished row of any day (moved
   * to today, keeping its items, body and key), otherwise today's new row
   * with their due items. A member whose today is already done gets nothing
   * and has their news moved to tomorrow.
   */
  private async claim(
    userId: string,
    now: Date,
  ): Promise<{ row: DigestRow; token: string } | undefined> {
    const day = utcDay(now);
    const token = randomUUID();
    const leaseUntil = new Date(now.getTime() + DIGEST_LEASE_MS);
    let resumed: DigestRow | null;
    try {
      resumed = await this.digestModel
        .findOneAndUpdate(
          {
            userId,
            $or: [
              { status: 'sending', leaseUntil: { $lt: now } },
              { status: 'failed', attempts: { $lt: DIGEST_MAX_ATTEMPTS } },
              { status: 'deferred' },
            ],
          },
          { $set: { day, status: 'sending', leaseUntil, leaseToken: token } },
          { sort: { createdAt: 1 }, returnDocument: 'after' },
        )
        .lean()
        .exec();
    } catch (error) {
      // Today already has a row of its own: that one is the day's.
      if (isDuplicateKey(error)) return undefined;
      throw error;
    }
    if (resumed) return { row: resumed, token };
    if (await this.digestModel.exists({ userId, day })) {
      await this.moveOn(userId, now);
      return undefined;
    }
    const items = await this.queueModel
      .find({
        userId,
        status: 'queued',
        delivery: 'digest',
        createdAt: { $lte: now },
        ...dueBy(now),
      })
      .sort({ createdAt: 1 })
      .limit(MAX_DIGEST_ITEMS)
      .select({ _id: 1 })
      .lean()
      .exec();
    if (items.length === 0) return undefined;
    const fields = {
      userId,
      day,
      status: 'sending' as const,
      itemIds: items.map((item) => item._id),
      attempts: 0,
      keyGen: 0,
      leaseUntil,
      leaseToken: token,
      expiresAt: new Date(now.getTime() + DIGEST_KEEP_DAYS * DAY_MS),
    };
    try {
      const created = await this.digestModel.create(fields);
      return { row: { ...fields, _id: created._id }, token };
    } catch (error) {
      // Another instance claimed it first.
      if (isDuplicateKey(error)) return undefined;
      throw error;
    }
  }
}
