import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  ReportQuota,
  type ReportQuotaDocument,
} from './schemas/report-quota.schema';

const DAY_MS = 24 * 60 * 60_000;

/** The UTC day a moment falls on, `YYYY-MM-DD`. */
export function utcDay(at: Date) {
  return at.toISOString().slice(0, 10);
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * The per-day report cap (Chunk 13 review M-1), atomic: taking a slot is ONE
 * conditional upsert on `{reporterUserId, day}`. Below the cap it increments
 * the day's counter (or creates it); at the cap the filter matches nothing,
 * so the upsert tries to insert a second counter for the same day, and the
 * unique index refuses it. Concurrent reports can therefore never take more
 * than `limit` slots.
 */
@Injectable()
export class ReportQuotaStore {
  private readonly logger = new Logger(ReportQuotaStore.name);

  constructor(
    @InjectModel(ReportQuota.name)
    private readonly quotaModel: Model<ReportQuotaDocument>,
  ) {}

  /**
   * @returns the day of the slot taken, or undefined when the cap is reached
   */
  async take(
    reporterUserId: string,
    limit: number,
    now = new Date(),
  ): Promise<string | undefined> {
    const day = utcDay(now);
    try {
      await this.quotaModel
        .updateOne(
          { reporterUserId, day, n: { $lt: limit } },
          {
            $inc: { n: 1 },
            $setOnInsert: {
              expiresAt: new Date(Date.parse(day) + 2 * DAY_MS),
            },
          },
          { upsert: true },
        )
        .exec();
      return day;
    } catch (error) {
      if (isDuplicateKey(error)) return undefined;
      throw error;
    }
  }

  /**
   * Gives a slot back when the report it was taken for was not stored (a
   * duplicate, or a failure). Best effort: a lost give-back only makes the
   * cap stricter that day.
   */
  async giveBack(reporterUserId: string, day: string) {
    try {
      await this.quotaModel
        .updateOne({ reporterUserId, day, n: { $gt: 0 } }, { $inc: { n: -1 } })
        .exec();
    } catch (error) {
      this.logger.warn(
        `Could not give a report slot back: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
