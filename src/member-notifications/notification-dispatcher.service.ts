import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import {
  AdminInboxEntry,
  type AdminInboxEntryDocument,
} from '../admin-inbox/schemas/admin-inbox.schema';
import { AdminAccessService } from '../auth/admin-access.service';
import { ClerkAdminDirectoryService } from '../auth/clerk-admin-directory.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DigestSender } from './digest-sender';
import { EmailBudgetStore, nextUtcDay } from './email-budget.store';
import { composeEmail } from './notification-mail';
import { readNotificationConfig } from './notification-config';
import { deliveryFor } from './notification-kinds';
import { NotificationPrefsService } from './notification-prefs.service';
import {
  NotificationTargets,
  type Recipient,
} from './notification-targets.service';
import {
  ADMINS_RECIPIENT,
  NotificationQueueRow,
  type NotificationQueueDocument,
  QUEUE_KEEP_DAYS,
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
/** How often the in-app tick runs while the server is awake. */
export const TICK_MS = 60 * MINUTE_MS;
/** How long a tick holds a row it is working on. */
export const LEASE_MS = 10 * MINUTE_MS;
/** Wait before an immediate email is tried again. */
export const RETRY_MS = 15 * MINUTE_MS;
/** Send attempts before giving up on an email. */
export const MAX_ATTEMPTS = 3;
/** Tries at an admin notice while the admin list reads incomplete. */
export const MAX_FANOUT_ATTEMPTS = 6;
/** Rows of each kind handled per pass, so one pass stays short. */
export const PASS_LIMIT = 50;
/**
 * A row this close to its TTL while still queued is marked failed instead
 * (review M1), so it is counted rather than vanishing.
 */
export const EXPIRY_MARGIN_MS = 3 * DAY_MS;
/** How long such a failed row stays to be counted. */
export const EXPIRED_KEEP_MS = 7 * DAY_MS;
export const EXPIRED_UNSENT = 'expired unsent';
export const ADMIN_LIST_INCOMPLETE = 'admin list incomplete';

type QueueRow = NotificationQueueRow & { _id: Types.ObjectId };

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

/** What the admin dashboard shows about email (Chunk 14). */
export interface NotificationStatusView {
  enabled: boolean;
  digestHourUtc: number;
  budget: Awaited<ReturnType<EmailBudgetStore['status']>>;
  waiting: { digest: number; immediate: number; adminNotices: number };
  /** Notices that failed (single emails, and items that expired unsent). */
  failedLast7Days: number;
  /** Daily summaries that ran out of attempts (review L7). */
  digestFailedLast7Days: number;
}

/**
 * Sends what `MemberNotifier` queued (Chunk 14). No external scheduler: an
 * hourly in-app tick, one run when the server starts (Render's free instance
 * sleeps, so every wake catches up), and a short run right after an event
 * that wants an immediate email. Every step claims its rows first (a lease
 * on the row, or the unique per-member-per-day digest row), so two server
 * instances never send the same email twice.
 *
 * A send that may have happened is retried under the SAME idempotency key
 * with the SAME stored body; only a definite refusal gets a new key
 * (review L2, L3).
 */
@Injectable()
export class NotificationDispatcher
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationDispatcher.name);
  private readonly settings: ReturnType<typeof readNotificationConfig>;
  private timer?: ReturnType<typeof setInterval>;
  private chain: Promise<void> = Promise.resolve();
  private kickQueued = false;

  constructor(
    @InjectModel(NotificationQueueRow.name)
    private readonly queueModel: Model<NotificationQueueDocument>,
    @InjectModel(AdminInboxEntry.name)
    private readonly inboxModel: Model<AdminInboxEntryDocument>,
    config: ConfigService,
    private readonly prefs: NotificationPrefsService,
    private readonly targets: NotificationTargets,
    private readonly budget: EmailBudgetStore,
    private readonly mail: NotificationsService,
    private readonly digests: DigestSender,
    private readonly directory: ClerkAdminDirectoryService,
    private readonly adminAccess: AdminAccessService,
  ) {
    this.settings = readNotificationConfig(config);
  }

  onApplicationBootstrap() {
    if (this.settings.publicApiUrlProblem) {
      this.logger.warn(
        `PUBLIC_API_URL is ignored: ${this.settings.publicApiUrlProblem}. Emails offer the website's unsubscribe page instead of one-click.`,
      );
    }
    if (!this.mail.noticesEnabled()) {
      this.logger.warn(
        'Member notifications are queued but not sent: RESEND_API_KEY or a sender address is missing.',
      );
    }
    // Runs even when sending is off: the expiry sweep must still run
    // (review N5).
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    // The catch-up after a wake, its expiry sweep first of all; never holds
    // up the start.
    void this.tick();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** A full pass: expiries, admin fan-out, immediate emails, due digests. */
  tick(now?: Date): Promise<void> {
    return this.enqueue(() => this.pass(true, now ?? new Date()));
  }

  /**
   * A short pass (fan-out and immediate emails) soon after an event. Calls
   * while one is already waiting share it.
   */
  kick(): Promise<void> {
    if (this.kickQueued) return this.chain;
    this.kickQueued = true;
    return this.enqueue(async () => {
      this.kickQueued = false;
      await this.pass(false, new Date());
    });
  }

  async status(now = new Date()): Promise<NotificationStatusView> {
    const count = (filter: object) =>
      this.queueModel.countDocuments(filter).exec();
    const since = new Date(now.getTime() - 7 * DAY_MS);
    const [budget, digest, immediate, adminNotices, failed, digestFailed] =
      await Promise.all([
        this.budget.status(now),
        count({ status: 'queued', delivery: 'digest' }),
        count({ status: 'queued', delivery: 'immediate' }),
        count({ status: 'queued', delivery: 'fanout' }),
        count({ status: 'failed', updatedAt: { $gte: since } }),
        this.digests.failedSince(since),
      ]);
    return {
      enabled: this.mail.noticesEnabled(),
      digestHourUtc: this.settings.digestHourUtc,
      budget,
      waiting: { digest, immediate, adminNotices },
      failedLast7Days: failed,
      digestFailedLast7Days: digestFailed,
    };
  }

  /** One pass at a time in this process; a failure never stops the next. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work).catch((error: unknown) => {
      this.logger.error(`Notification pass failed: ${describe(error)}`);
    });
    this.chain = next;
    return next;
  }

  private async pass(full: boolean, now: Date) {
    // First, whether or not sending is on (review N5).
    if (full) await this.step('expiries', () => this.expire(now));
    if (!this.mail.noticesEnabled()) return;
    await this.step('admin fan-out', () => this.fanOut(now));
    await this.step('immediate emails', () => this.immediates(now));
    if (full) {
      await this.step('daily digests', () => this.digests.run(now));
    }
  }

  private async step(name: string, work: () => Promise<void>) {
    try {
      await work();
    } catch (error) {
      this.logger.error(`Notification ${name} failed: ${describe(error)}`);
    }
  }

  /**
   * Marks rows about to expire while still queued as failed, and keeps them
   * a week (review M1): counted on the dashboard instead of vanishing. Never
   * a row a tick holds, nor an item an unfinished digest holds: those may
   * be mid-send (review N4).
   */
  private async expire(now: Date) {
    const held = await this.digests.itemsInFlight();
    const result = await this.queueModel
      .updateMany(
        {
          status: 'queued',
          expiresAt: { $lte: new Date(now.getTime() + EXPIRY_MARGIN_MS) },
          $or: [
            { leaseUntil: { $exists: false } },
            { leaseUntil: { $lt: now } },
          ],
          ...(held.length > 0 ? { _id: { $nin: held } } : {}),
        },
        {
          $set: {
            status: 'failed',
            outcome: EXPIRED_UNSENT,
            expiresAt: new Date(now.getTime() + EXPIRED_KEEP_MS),
          },
        },
      )
      .exec();
    if (result.modifiedCount > 0) {
      this.logger.warn(
        `${result.modifiedCount} notification(s) expired without being sent.`,
      );
    }
  }

  /**
   * Takes the OLDEST due row of `delivery`, holding it for
   * {@link LEASE_MS}. Due = no wait set, or its wait is over; the order is
   * by age alone, so a row that waited (for a new day's budget) keeps its
   * place (review M1).
   */
  private async claim(
    delivery: 'fanout' | 'immediate',
    now: Date,
  ): Promise<{ row: QueueRow; token: string } | undefined> {
    const token = randomUUID();
    const row = (await this.queueModel
      .findOneAndUpdate(
        {
          status: 'queued',
          delivery,
          $and: [
            {
              $or: [
                { nextAttemptAt: { $exists: false } },
                { nextAttemptAt: { $lte: now } },
              ],
            },
            {
              $or: [
                { leaseUntil: { $exists: false } },
                { leaseUntil: { $lt: now } },
              ],
            },
          ],
        },
        {
          $set: {
            leaseUntil: new Date(now.getTime() + LEASE_MS),
            leaseToken: token,
          },
        },
        { sort: { createdAt: 1, _id: 1 }, returnDocument: 'after' },
      )
      .lean()
      .exec()) as unknown as QueueRow | null;
    return row ? { row, token } : undefined;
  }

  /**
   * Ends the hold on a row with these changes, if it is still ours. The
   * status is always written: `queued` unless the change names another
   * (review N4).
   */
  private async settle(
    row: QueueRow,
    token: string,
    set: Record<string, unknown>,
    unset: Record<string, 1> = {},
  ) {
    await this.queueModel
      .updateOne(
        { _id: row._id, leaseToken: token },
        {
          $set: { status: 'queued', ...set },
          $unset: { ...unset, leaseUntil: 1, leaseToken: 1 },
        },
      )
      .exec();
  }

  /**
   * Copies each admin notice to every admin but the one it is about. When
   * the admin list reads incomplete, the admins it has are told (once each:
   * per-admin dedupe) and the notice is kept and tried again, up to
   * {@link MAX_FANOUT_ATTEMPTS} times (review L9).
   */
  private async fanOut(now: Date) {
    let admins: { ids: string[]; complete: boolean } | undefined;
    for (let n = 0; n < PASS_LIMIT; n++) {
      const claimed = await this.claim('fanout', now);
      if (!claimed) return;
      const { row, token } = claimed;
      admins ??= await this.adminIds();
      if (!admins) {
        // The admin list could not be read: try again later.
        await this.settle(row, token, {
          nextAttemptAt: new Date(now.getTime() + RETRY_MS),
        });
        return;
      }
      for (const adminId of admins.ids) {
        if (adminId === row.subjectUserId || adminId === row.actorUserId) {
          continue;
        }
        const delivery = deliveryFor(
          row.category,
          await this.prefs.get(adminId),
        );
        if (!delivery) continue;
        try {
          await this.queueModel.create({
            userId: adminId,
            category: row.category,
            kind: row.kind,
            delivery,
            status: 'queued',
            subjectUserId: row.subjectUserId,
            actorUserId: row.actorUserId,
            refs: row.refs,
            dedupeKey: `fan:${String(row._id)}:${adminId}`,
            attempts: 0,
            expiresAt: new Date(now.getTime() + QUEUE_KEEP_DAYS * DAY_MS),
          });
        } catch (error) {
          // Already told: an earlier try, or a tick that died part-way.
          if (!isDuplicateKey(error)) throw error;
        }
      }
      const attempts = row.attempts + 1;
      if (!admins.complete && attempts < MAX_FANOUT_ATTEMPTS) {
        await this.settle(row, token, {
          attempts,
          nextAttemptAt: new Date(now.getTime() + RETRY_MS),
        });
        continue;
      }
      await this.settle(row, token, {
        status: 'done',
        attempts,
        ...(admins.complete ? {} : { outcome: ADMIN_LIST_INCOMPLETE }),
      });
      if (row.refs?.inboxKey) {
        await this.inboxModel
          .updateOne(
            { dedupeKey: row.refs.inboxKey },
            { $set: { emailedAt: now } },
          )
          .exec();
      }
    }
  }

  /**
   * Every admin now: the Clerk role holders and the switch-over allowlist's
   * verified accounts, as the dashboard's Roles section counts them.
   *
   * @returns undefined when Clerk cannot be read
   */
  private async adminIds(): Promise<
    { ids: string[]; complete: boolean } | undefined
  > {
    try {
      const { holders, complete } = await this.directory.holdersOf('admin');
      if (!complete) {
        this.logger.warn(
          'The admin list is incomplete; notices go to those read and are tried again.',
        );
      }
      const ids = new Set(holders.map((holder) => holder.userId));
      const allowlist = new Set(this.adminAccess.allowlist());
      if (allowlist.size > 0) {
        for (const {
          holder,
          emailVerified,
        } of await this.directory.usersByEmail([...allowlist])) {
          if (
            emailVerified &&
            holder.email !== undefined &&
            allowlist.has(holder.email)
          ) {
            ids.add(holder.userId);
          }
        }
      }
      return { ids: [...ids], complete };
    } catch (error) {
      this.logger.warn(`Could not read the admin list: ${describe(error)}`);
      return undefined;
    }
  }

  /** Sends due immediate emails, until the budget says stop. */
  private async immediates(now: Date) {
    for (let n = 0; n < PASS_LIMIT; n++) {
      const claimed = await this.claim('immediate', now);
      if (!claimed) return;
      if ((await this.sendOne(claimed.row, claimed.token, now)) === 'budget') {
        return;
      }
    }
  }

  private async sendOne(
    row: QueueRow,
    token: string,
    now: Date,
  ): Promise<'done' | 'budget'> {
    const skip = (outcome: string) =>
      this.settle(row, token, { status: 'skipped', outcome });
    // Nothing was sent: no key was used, so it stays as it is.
    const retry = async (outcome: string) => {
      const attempts = row.attempts + 1;
      await this.settle(
        row,
        token,
        attempts >= MAX_ATTEMPTS
          ? { status: 'failed', attempts, outcome }
          : {
              attempts,
              outcome,
              nextAttemptAt: new Date(now.getTime() + RETRY_MS),
            },
      );
    };
    if (row.userId === ADMINS_RECIPIENT) {
      await skip('not a reader');
      return 'done';
    }
    if (keyMayHaveExpired(row, now)) {
      await this.settle(row, token, {
        status: 'failed',
        outcome: UNKNOWN_GIVE_UP,
      });
      return 'done';
    }
    let recipient: Recipient | undefined;
    try {
      recipient = await this.targets.recipient(row.userId);
    } catch (error) {
      this.logger.warn(`Could not read a reader's account: ${describe(error)}`);
      await retry('account unavailable');
      return 'done';
    }
    const delivery = recipient
      ? deliveryFor(row.category, await this.prefs.get(row.userId))
      : undefined;
    const build = async () => {
      const described = await this.targets.describe(row, recipient!);
      return described
        ? composeEmail({
            items: [described],
            digest: false,
            userId: row.userId,
            scope: row.category,
            signingKey: this.settings.signingKey,
            publicAppUrl: this.settings.publicAppUrl,
            publicApiUrl: this.settings.publicApiUrl,
          })
        : undefined;
    };

    let email: StoredEmail;
    if (row.keyStartedAt && row.email) {
      // A send may already have happened under this key: replay its body
      // byte for byte, but only while every check still allows exactly it
      // (review N6). Otherwise send nothing, and say so.
      const now_ = delivery ? await build() : undefined;
      if (!recipient?.email || !now_ || !sameEmail(now_, row.email)) {
        await this.settle(row, token, {
          status: 'failed',
          outcome: WITHDRAWN,
        });
        return 'done';
      }
      email = row.email;
    } else {
      if (!recipient) {
        await skip('account gone');
        return 'done';
      }
      if (!delivery) {
        await skip('turned off');
        return 'done';
      }
      if (delivery === 'digest') {
        // Immediate emails were turned off since: it waits for the digest.
        await this.settle(row, token, { delivery: 'digest' }, { email: 1 });
        return 'done';
      }
      const built = await build();
      if (!built) {
        await skip('no longer visible');
        return 'done';
      }
      if (!recipient.email) {
        await skip('no verified address');
        return 'done';
      }
      email = built;
    }
    if (!(await this.budget.take('immediate', now))) {
      await this.settle(row, token, { nextAttemptAt: nextUtcDay(now) });
      return 'budget';
    }
    // Stored, with when this key's first send started, BEFORE the send, so
    // a takeover replays this very body and a crash still counts from then
    // (review L3, N3).
    await this.queueModel
      .updateOne(
        { _id: row._id, leaseToken: token },
        { $set: { email, keyStartedAt: row.keyStartedAt ?? now } },
      )
      .exec();
    const result = await this.mail.sendNotice({
      to: recipient.email,
      subject: email.subject,
      lines: email.lines,
      headers: email.headers,
      idempotencyKey: sendKey('org-notice', row._id, row),
    });
    if (result === 'sent') {
      await this.settle(row, token, { status: 'sent', sentAt: new Date() });
      return 'done';
    }
    const next = afterFailedSend(result, row, MAX_ATTEMPTS);
    await this.settle(
      row,
      token,
      next.final
        ? {
            ...next.set,
            status: 'failed',
            outcome: next.refused ? 'send refused' : UNKNOWN_GIVE_UP,
          }
        : {
            ...next.set,
            outcome: next.refused ? 'send refused' : 'send outcome unknown',
            nextAttemptAt: new Date(now.getTime() + RETRY_MS),
          },
      next.refused ? { email: 1, keyStartedAt: 1 } : {},
    );
    return 'done';
  }
}

/** Why a replay was not sent: what it said is no longer all allowed. */
export const WITHDRAWN = 'withdrawn after unknown send';

/** The same email, exactly. */
function sameEmail(a: StoredEmail, b: StoredEmail): boolean {
  const body = (email: StoredEmail) =>
    JSON.stringify([email.subject, email.lines, email.headers]);
  return body(a) === body(b);
}
