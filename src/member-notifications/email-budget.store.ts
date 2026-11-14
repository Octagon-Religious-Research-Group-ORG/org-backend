import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { utcDay } from '../moderation/report-quota.store';
import {
  EmailBudgetDay,
  type EmailBudgetDocument,
} from './schemas/email-budget.schema';
import { readNotificationConfig } from './notification-config';

const DAY_MS = 24 * 60 * 60_000;

/** A send class: digests stop short of the immediate reserve. */
export type BudgetClass = 'digest' | 'immediate';

export interface BudgetStatus {
  day: string;
  sent: number;
  dailyLimit: number;
  immediateReserve: number;
  /** When a send was first refused today for want of budget. */
  limitHitAt?: string;
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * The daily email budget (Chunk 14): one counter per UTC day, taken one slot
 * at a time with `$inc` only while under the class's limit, so however many
 * ticks or instances run at once the day can never go over.
 *
 * Immediate emails may use the whole `dailyLimit`; digests only
 * `dailyLimit - immediateReserve`, so a busy digest day still leaves room
 * for claim and moderation emails. What does not fit waits for the next day.
 */
@Injectable()
export class EmailBudgetStore {
  private readonly logger = new Logger(EmailBudgetStore.name);
  private readonly dailyLimit: number;
  private readonly immediateReserve: number;
  /** The last day this process logged the limit, so it logs once a day. */
  private loggedDay?: string;

  constructor(
    @InjectModel(EmailBudgetDay.name)
    private readonly budgetModel: Model<EmailBudgetDocument>,
    config: ConfigService,
  ) {
    const settings = readNotificationConfig(config);
    this.dailyLimit = settings.dailyLimit;
    this.immediateReserve = Math.min(
      settings.immediateReserve,
      settings.dailyLimit,
    );
  }

  limitFor(cls: BudgetClass) {
    return cls === 'immediate'
      ? this.dailyLimit
      : this.dailyLimit - this.immediateReserve;
  }

  /** @returns whether a slot was taken */
  async take(cls: BudgetClass, now = new Date()): Promise<boolean> {
    const day = utcDay(now);
    try {
      await this.budgetModel
        .updateOne(
          { _id: day },
          {
            $setOnInsert: {
              n: 0,
              expiresAt: new Date(Date.parse(day) + 8 * DAY_MS),
            },
          },
          { upsert: true },
        )
        .exec();
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
    const taken = await this.budgetModel
      .updateOne(
        { _id: day, n: { $lt: this.limitFor(cls) } },
        { $inc: { n: 1 } },
      )
      .exec();
    if (taken.matchedCount === 1) return true;
    await this.budgetModel
      .updateOne(
        { _id: day, limitHitAt: { $exists: false } },
        { $set: { limitHitAt: now } },
      )
      .exec();
    if (this.loggedDay !== day) {
      this.loggedDay = day;
      this.logger.warn(
        `The ${cls} email budget for ${day} is used up (${this.limitFor(cls)} of ${this.dailyLimit}); the rest waits for tomorrow.`,
      );
    }
    return false;
  }

  async status(now = new Date()): Promise<BudgetStatus> {
    const day = utcDay(now);
    const row = await this.budgetModel.findOne({ _id: day }).lean().exec();
    return {
      day,
      sent: row?.n ?? 0,
      dailyLimit: this.dailyLimit,
      immediateReserve: this.immediateReserve,
      ...(row?.limitHitAt ? { limitHitAt: row.limitHitAt.toISOString() } : {}),
    };
  }
}

/** The start of the next UTC day. */
export function nextUtcDay(now: Date): Date {
  return new Date(Date.parse(utcDay(now)) + DAY_MS);
}
