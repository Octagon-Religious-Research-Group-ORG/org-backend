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
/** Rows of each kind handled per pass, so one pass stays short. */
export const PASS_LIMIT = 50;

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
  failedLast7Days: number;
}

/**
 * Sends what `MemberNotifier` queued (Chunk 14). No external scheduler: an
 * hourly in-app tick, one run when the server starts (Render's free instance
 * sleeps, so every wake catches up), and a short run right after an event
 * that wants an immediate email. Every step claims its rows first (a lease
 * on the row, or the unique per-member-per-day digest row), so two server
 * instances never send the same email twice.
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
    if (!this.mail.noticesEnabled()) {
      this.logger.warn(
        'Member notifications are queued but not sent: RESEND_API_KEY or a sender address is missing.',
      );
      return;
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    // The catch-up after a wake; never holds up the start.
    void this.tick();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** A full pass: admin fan-out, immediate emails, then due digests. */
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
    const [budget, digest, immediate, adminNotices, failedLast7Days] =
      await Promise.all([
        this.budget.status(now),
        count({ status: 'queued', delivery: 'digest' }),
        count({ status: 'queued', delivery: 'immediate' }),
        count({ status: 'queued', delivery: 'fanout' }),
        count({
          status: 'failed',
          updatedAt: { $gte: new Date(now.getTime() - 7 * DAY_MS) },
        }),
      ]);
    return {
      enabled: this.mail.noticesEnabled(),
      digestHourUtc: this.settings.digestHourUtc,
      budget,
      waiting: { digest, immediate, adminNotices },
      failedLast7Days,
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

  /** Takes one due row of `delivery`, holding it for {@link LEASE_MS}. */
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
        { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: 'after' },
      )
      .lean()
      .exec()) as unknown as QueueRow | null;
    return row ? { row, token } : undefined;
  }

  /** Ends the hold on a row with these changes, if it is still ours. */
  private async settle(
    row: QueueRow,
    token: string,
    set: Record<string, unknown>,
  ) {
    await this.queueModel
      .updateOne(
        { _id: row._id, leaseToken: token },
        { $set: set, $unset: { leaseUntil: 1, leaseToken: 1 } },
      )
      .exec();
  }

  /** Copies each admin notice to every admin but the one it is about. */
  private async fanOut(now: Date) {
    let admins: string[] | undefined;
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
      for (const adminId of admins) {
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
          // Fanned out already by a tick that died before finishing.
          if (!isDuplicateKey(error)) throw error;
        }
      }
      await this.settle(row, token, { status: 'done' });
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
  private async adminIds(): Promise<string[] | undefined> {
    try {
      const { holders, complete } = await this.directory.holdersOf('admin');
      if (!complete) {
        this.logger.warn(
          'The admin list is incomplete; notices go to those read.',
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
      return [...ids];
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
    let recipient: Recipient | undefined;
    try {
      recipient = await this.targets.recipient(row.userId);
    } catch (error) {
      this.logger.warn(`Could not read a reader's account: ${describe(error)}`);
      await retry('account unavailable');
      return 'done';
    }
    if (!recipient) {
      await skip('account gone');
      return 'done';
    }
    const delivery = deliveryFor(
      row.category,
      await this.prefs.get(row.userId),
    );
    if (!delivery) {
      await skip('turned off');
      return 'done';
    }
    if (delivery === 'digest') {
      // Immediate emails were turned off since: it waits for the digest.
      await this.settle(row, token, { delivery: 'digest' });
      return 'done';
    }
    const described = await this.targets.describe(row, recipient);
    if (!described) {
      await skip('no longer visible');
      return 'done';
    }
    if (!recipient.email) {
      await skip('no verified address');
      return 'done';
    }
    if (!(await this.budget.take('immediate', now))) {
      await this.settle(row, token, { nextAttemptAt: nextUtcDay(now) });
      return 'budget';
    }
    const email = composeEmail({
      items: [described],
      digest: false,
      userId: row.userId,
      scope: row.category,
      signingKey: this.settings.signingKey,
      publicAppUrl: this.settings.publicAppUrl,
      publicApiUrl: this.settings.publicApiUrl,
    });
    const result = await this.mail.sendNotice({
      to: recipient.email,
      ...email,
      idempotencyKey: `org-notice-${String(row._id)}-${row.attempts}`,
    });
    if (result === 'sent') {
      await this.settle(row, token, { status: 'sent', sentAt: new Date() });
    } else {
      await retry('send failed');
    }
    return 'done';
  }
}
