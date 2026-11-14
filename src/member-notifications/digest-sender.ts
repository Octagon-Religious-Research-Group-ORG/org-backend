import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection, Model, Types } from 'mongoose';
import { inTransaction } from '../db/transactions';
import { utcDay } from '../moderation/report-quota.store';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailBudgetStore } from './email-budget.store';
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

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** How long a tick holds a member's digest of the day. */
export const DIGEST_LEASE_MS = 10 * MINUTE_MS;
/** Send attempts of one day's digest before its items wait for tomorrow. */
export const DIGEST_MAX_ATTEMPTS = 3;
/** Items in one digest at most; the rest goes in the next one. */
export const MAX_DIGEST_ITEMS = 100;
/** Members looked at per pass. */
export const DIGEST_MEMBERS_PER_PASS = 200;
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

/**
 * The daily digest (Chunk 14): one email per member per UTC day with what
 * queued for them since their last one.
 *
 * - **When:** from `DIGEST_HOUR_UTC` on, or at once for a member whose
 *   oldest waiting item is over a day old (the server slept through the
 *   hour: the catch-up).
 * - **Once a day:** the unique (userId, day) row is the claim. A tick that
 *   dies holding it is taken over after {@link DIGEST_LEASE_MS}, with the
 *   SAME items and the SAME Resend idempotency key, so a send that did
 *   happen is not repeated (Resend keeps keys 24 hours).
 * - **Budget:** digests stop short of the immediate reserve; a member who
 *   does not fit keeps their items for a later tick or day (oldest first).
 * - **Marking:** the row and its items become `sent` in one transaction.
 */
@Injectable()
export class DigestSender {
  private readonly logger = new Logger(DigestSender.name);
  private readonly settings: ReturnType<typeof readNotificationConfig>;

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

  async run(now: Date) {
    const waiting = (await this.queueModel
      .aggregate([
        {
          $match: {
            status: 'queued',
            delivery: 'digest',
            createdAt: { $lte: now },
          },
        },
        { $group: { _id: '$userId', oldest: { $min: '$createdAt' } } },
        { $sort: { oldest: 1 } },
        { $limit: DIGEST_MEMBERS_PER_PASS },
      ])
      .exec()) as Array<{ _id: string; oldest: Date }>;
    const hourReached = now.getUTCHours() >= this.settings.digestHourUtc;
    for (const { _id: userId, oldest } of waiting) {
      const overdue = now.getTime() - oldest.getTime() >= DAY_MS;
      if (!hourReached && !overdue) continue;
      try {
        if ((await this.forMember(userId, now)) === 'budget') return;
      } catch (error) {
        this.logger.error(`A digest failed: ${describe(error)}`);
      }
    }
  }

  /** Claims, builds and sends one member's digest of the day. */
  async forMember(
    userId: string,
    now: Date,
  ): Promise<'sent' | 'skipped' | 'budget' | 'failed'> {
    const claimed = await this.claim(userId, now);
    if (!claimed) return 'skipped';
    const { row, token } = claimed;
    const finish = (set: Record<string, unknown>) =>
      this.digestModel
        .updateOne(
          { _id: row._id, leaseToken: token },
          { $set: set, $unset: { leaseUntil: 1, leaseToken: 1 } },
        )
        .exec();
    const fail = () => finish({ status: 'failed', attempts: row.attempts + 1 });

    let recipient: Recipient | undefined;
    try {
      recipient = await this.targets.recipient(userId);
    } catch (error) {
      this.logger.warn(`Could not read a reader's account: ${describe(error)}`);
      await fail();
      return 'failed';
    }
    const items = (await this.queueModel
      .find({ _id: { $in: row.itemIds }, status: 'queued' })
      .sort({ createdAt: 1 })
      .lean()
      .exec()) as unknown as ItemRow[];
    const prefs = await this.prefs.get(userId);
    const shown: Array<{ item: ItemRow; line: Described }> = [];
    const dropped: Array<{ id: Types.ObjectId; outcome: string }> = [];
    for (const item of items) {
      if (!recipient) {
        dropped.push({ id: item._id, outcome: 'account gone' });
      } else if (!deliveryFor(item.category, prefs) || !prefs.digest) {
        dropped.push({ id: item._id, outcome: 'turned off' });
      } else {
        const line = await this.targets.describe(item, recipient);
        if (line) shown.push({ item, line });
        else dropped.push({ id: item._id, outcome: 'no longer visible' });
      }
    }
    if (shown.length > 0 && !recipient?.email) {
      for (const { item } of shown.splice(0)) {
        dropped.push({ id: item._id, outcome: 'no verified address' });
      }
    }
    for (const { id, outcome } of dropped) {
      await this.queueModel
        .updateOne(
          { _id: id, status: 'queued' },
          { $set: { status: 'skipped', outcome } },
        )
        .exec();
    }
    if (shown.length === 0 || !recipient?.email) {
      await finish({ status: 'nothing' });
      return 'skipped';
    }
    if (!(await this.budget.take('digest', now))) {
      await finish({ status: 'deferred' });
      return 'budget';
    }
    const email = composeEmail({
      items: shown.map(({ line }) => line),
      digest: true,
      userId,
      scope: 'digest',
      signingKey: this.settings.signingKey,
      publicAppUrl: this.settings.publicAppUrl,
      publicApiUrl: this.settings.publicApiUrl,
    });
    const result = await this.mail.sendNotice({
      to: recipient.email,
      ...email,
      idempotencyKey: `org-digest-${String(row._id)}-${row.attempts}`,
    });
    if (result !== 'sent') {
      await fail();
      return 'failed';
    }
    const sentAt = new Date();
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
          { _id: { $in: shown.map(({ item }) => item._id) }, status: 'queued' },
          { $set: { status: 'sent', sentAt, digestId: row._id } },
          { session },
        )
        .exec();
    });
    return 'sent';
  }

  /**
   * The member's row of the day: a new one with their waiting items, or one
   * that can be taken over (a dead tick's, a failed send with attempts left,
   * or one deferred for want of budget).
   */
  private async claim(
    userId: string,
    now: Date,
  ): Promise<{ row: DigestRow; token: string } | undefined> {
    const day = utcDay(now);
    const token = randomUUID();
    const leaseUntil = new Date(now.getTime() + DIGEST_LEASE_MS);
    const existing = await this.digestModel
      .findOne({ userId, day })
      .select({ _id: 1 })
      .lean()
      .exec();
    if (!existing) {
      const items = await this.queueModel
        .find({
          userId,
          status: 'queued',
          delivery: 'digest',
          createdAt: { $lte: now },
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
    const row = (await this.digestModel
      .findOneAndUpdate(
        {
          _id: existing._id,
          $or: [
            { status: 'sending', leaseUntil: { $lt: now } },
            { status: 'failed', attempts: { $lt: DIGEST_MAX_ATTEMPTS } },
            { status: 'deferred' },
          ],
        },
        { $set: { status: 'sending', leaseUntil, leaseToken: token } },
        { returnDocument: 'after' },
      )
      .lean()
      .exec()) as unknown as DigestRow | null;
    return row ? { row, token } : undefined;
  }
}
