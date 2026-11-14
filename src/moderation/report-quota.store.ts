import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  ReportQuota,
  type ReportQuotaDocument,
  reportQuotaId,
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
 * The per-day report cap (Chunk 13 review M-1, F1, F2), atomic, in two
 * steps on the day's row, whose `_id` is `<reporterUserId>|<day>`:
 *
 * 1. make sure the row exists: an upsert on `_id` equality only, which the
 *    server retries itself when two first reports of the day race (F2);
 * 2. take a slot: `$inc` only while `n < limit`. One document update is
 *    atomic, so concurrent reports can never take more than `limit` slots;
 *    no match means the cap is reached.
 *
 * The `_id` index exists on every collection, so the cap does not depend on
 * `db:indexes` having run (F1).
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
    const _id = reportQuotaId(reporterUserId, day);
    try {
      await this.quotaModel
        .updateOne(
          { _id },
          {
            $setOnInsert: {
              reporterUserId,
              day,
              n: 0,
              expiresAt: new Date(Date.parse(day) + 2 * DAY_MS),
            },
          },
          { upsert: true },
        )
        .exec();
    } catch (error) {
      // A server that did not retry the race: the row exists, which is all
      // this step needs.
      if (!isDuplicateKey(error)) throw error;
    }
    const taken = await this.quotaModel
      .updateOne({ _id, n: { $lt: limit } }, { $inc: { n: 1 } })
      .exec();
    return taken.matchedCount === 1 ? day : undefined;
  }

  /**
   * Gives a slot back when the report it was taken for was not stored (a
   * duplicate, or a failure). Never below zero. Best effort: a lost
   * give-back only makes the cap stricter that day.
   */
  async giveBack(reporterUserId: string, day: string) {
    try {
      await this.quotaModel
        .updateOne(
          { _id: reportQuotaId(reporterUserId, day), n: { $gt: 0 } },
          { $inc: { n: -1 } },
        )
        .exec();
    } catch (error) {
      this.logger.warn(
        `Could not give a report slot back: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
