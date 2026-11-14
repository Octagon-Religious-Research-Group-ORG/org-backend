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

  /**
   * Item ids held by any unfinished digest row (sending, failed with tries
   * left, or deferred), of one member or of everyone: never taken by a new
   * row (review N2) nor swept as expired (review N4).
   */
  async itemsInFlight(userId?: string): Promise<Types.ObjectId[]> {
    const rows = (await this.digestModel
      .find({ ...(userId ? { userId } : {}), ...UNFINISHED })
      .select({ itemIds: 1 })
      .lean()
      .exec()) as unknown as Array<{ itemIds: Types.ObjectId[] }>;
    return rows.flatMap((row) => row.itemIds);
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
      await finish({
        status: 'failed',
        attempts: DIGEST_MAX_ATTEMPTS,
        outcome: UNKNOWN_GIVE_UP,
      });
      await this.drop(row.shownIds ?? row.itemIds, UNKNOWN_GIVE_UP, 'failed');
      return 'failed';
    }
    let recipient: Recipient | undefined;
    try {
      recipient = await this.targets.recipient(userId);
    } catch (error) {
      this.logger.warn(`Could not read a reader's account: ${describe(error)}`);
      // Nothing more was sent, so the key stays as it is.
      const attempts = row.attempts + 1;
      await finish({ status: 'failed', attempts });
      if (attempts >= DIGEST_MAX_ATTEMPTS) {
        await this.moveOn(userId, now, row.itemIds);
      }
      return 'failed';
    }

    // A send may already have happened under this key: replay the stored
    // body byte for byte, but only while every check still allows exactly
    // it (review N6). Otherwise send nothing, and say so.
    const replay =
      row.keyStartedAt && row.email && row.shownIds
        ? { email: row.email, shownIds: row.shownIds }
        : undefined;
    let email: StoredEmail;
    let shownIds: Types.ObjectId[];
    let to: string;
    if (replay) {
      const plan = recipient ? await this.build(row, recipient) : undefined;
      if (!recipient?.email || !plan || !samePlan(plan, replay)) {
        await finish({
          status: 'failed',
          attempts: DIGEST_MAX_ATTEMPTS,
          outcome: WITHDRAWN,
        });
        await this.drop(replay.shownIds, WITHDRAWN, 'failed');
        await this.moveOn(userId, now);
        return 'failed';
      }
      ({ email, shownIds } = replay);
      to = recipient.email;
    } else {
      if (!recipient) {
        await this.drop(row.itemIds, 'account gone');
        await finish({ status: 'nothing' });
        await this.moveOn(userId, now);
        return 'skipped';
      }
      // Fresh: apply what the reader's settings and access say now.
      const plan = await this.build(row, recipient);
      for (const { id, outcome } of plan.drops) {
        await this.drop([id], outcome);
      }
      for (const id of plan.toImmediate) {
        await this.queueModel
          .updateOne(
            { _id: id, status: 'queued' },
            { $set: { delivery: 'immediate' }, $unset: { nextAttemptAt: 1 } },
          )
          .exec();
      }
      if (!plan.email) {
        await finish({ status: 'nothing' }, { email: 1, shownIds: 1 });
        await this.moveOn(userId, now);
        return 'skipped';
      }
      if (!recipient.email) {
        await this.drop(plan.shownIds, 'no verified address');
        await finish({ status: 'nothing' }, { email: 1, shownIds: 1 });
        await this.moveOn(userId, now);
        return 'skipped';
      }
      ({ email, shownIds } = { email: plan.email, shownIds: plan.shownIds });
      to = recipient.email;
    }
    if (!(await this.budget.take('digest', now))) {
      // Nothing was sent now: no body is kept for a fresh one, so the next
      // try is built again from what is allowed then (review N1).
      await finish(
        { status: 'deferred' },
        replay ? {} : { email: 1, shownIds: 1 },
      );
      return 'budget';
    }
    // Stored, with when this key's first send started, BEFORE the send: a
    // crash before the result is known still counts from then (review N3).
    await this.digestModel
      .updateOne(
        { _id: row._id, leaseToken: token },
        {
          $set: {
            email,
            shownIds,
            keyStartedAt: row.keyStartedAt ?? now,
          },
        },
      )
      .exec();
    const result = await this.mail.sendNotice({
      to,
      subject: email.subject,
      lines: email.lines,
      headers: email.headers,
      idempotencyKey: sendKey('org-digest', row._id, row),
    });
    if (result !== 'sent') {
      const next = afterFailedSend(result, row, DIGEST_MAX_ATTEMPTS);
      await finish(
        { ...next.set, status: 'failed' },
        next.refused ? { email: 1, shownIds: 1, keyStartedAt: 1 } : {},
      );
      if (next.final) {
        if (next.refused) await this.moveOn(userId, now, row.itemIds);
        else await this.drop(shownIds, UNKNOWN_GIVE_UP, 'failed');
      }
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
          { _id: { $in: shownIds }, status: 'queued' },
          { $set: { status: 'sent', sentAt, digestId: row._id } },
          { session },
        )
        .exec();
    });
    await this.moveOn(userId, now);
    return 'sent';
  }

  /**
   * What the email would say now, from the row's items as the reader may
   * see them now: READS ONLY. Items whose category or both channels are off
   * are to be dropped; claim and moderation news whose member now has
   * immediate emails on is to go that way instead (review L8). The caller
   * applies those only for a fresh email, never for a replay check.
   */
  private async build(row: DigestRow, recipient: Recipient): Promise<Plan> {
    const items = (await this.queueModel
      .find({ _id: { $in: row.itemIds }, status: 'queued', delivery: 'digest' })
      .sort({ createdAt: 1, _id: 1 })
      .lean()
      .exec()) as unknown as ItemRow[];
    const prefs = await this.prefs.get(row.userId);
    const shown: Array<{ item: ItemRow; line: Described }> = [];
    const plan: Plan = { shownIds: [], drops: [], toImmediate: [] };
    for (const item of items) {
      const delivery = deliveryFor(item.category, prefs);
      if (!delivery) {
        plan.drops.push({ id: item._id, outcome: 'turned off' });
      } else if (delivery === 'immediate') {
        plan.toImmediate.push(item._id);
      } else {
        const line = await this.targets.describe(item, recipient);
        if (line) shown.push({ item, line });
        else plan.drops.push({ id: item._id, outcome: 'no longer visible' });
      }
    }
    if (shown.length === 0) return plan;
    return {
      ...plan,
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
   * The member's digest to send:
   * - nothing while another tick holds any row of theirs (review N2);
   * - else an unfinished row of any day, moved to today, with its items,
   *   body and key;
   * - else today's new row with their due items, never items another
   *   unfinished row holds.
   * A member whose today is already done gets nothing, and their news is
   * moved to tomorrow.
   */
  private async claim(
    userId: string,
    now: Date,
  ): Promise<{ row: DigestRow; token: string } | undefined> {
    const day = utcDay(now);
    const token = randomUUID();
    const leaseUntil = new Date(now.getTime() + DIGEST_LEASE_MS);
    if (
      await this.digestModel.exists({
        userId,
        status: 'sending',
        leaseUntil: { $gte: now },
      })
    ) {
      return undefined;
    }
    let resumed: DigestRow | null;
    try {
      resumed = await this.digestModel
        .findOneAndUpdate(
          { userId, ...UNFINISHED },
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
    const held = await this.itemsInFlight(userId);
    const items = await this.queueModel
      .find({
        userId,
        status: 'queued',
        delivery: 'digest',
        createdAt: { $lte: now },
        ...(held.length > 0 ? { _id: { $nin: held } } : {}),
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

/** Rows not finished: being sent, failed with tries left, or deferred. */
const UNFINISHED = {
  $or: [
    { status: 'sending' as const },
    { status: 'failed' as const, attempts: { $lt: DIGEST_MAX_ATTEMPTS } },
    { status: 'deferred' as const },
  ],
};

/** Why a replay was not sent: what it said is no longer all allowed. */
export const WITHDRAWN = 'withdrawn after unknown send';

/** What a digest would say now, and what to do with the rest. */
interface Plan {
  email?: StoredEmail;
  shownIds: Types.ObjectId[];
  drops: Array<{ id: Types.ObjectId; outcome: string }>;
  toImmediate: Types.ObjectId[];
}

/** The same email about the same items, exactly. */
function samePlan(
  plan: Plan,
  stored: { email: StoredEmail; shownIds: Types.ObjectId[] },
): boolean {
  const ids = (list: Types.ObjectId[]) => list.map(String).sort().join(',');
  const body = (email: StoredEmail) =>
    JSON.stringify([email.subject, email.lines, email.headers]);
  return (
    plan.email !== undefined &&
    ids(plan.shownIds) === ids(stored.shownIds) &&
    body(plan.email) === body(stored.email)
  );
}
