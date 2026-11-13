import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import {
  Report,
  type ReportDocument,
  type ReportResolution,
  type ReportTargetType,
} from './schemas/report.schema';

/**
 * Closing reports (Chunk 13), shared by the moderation queue and by the
 * Members section's page removal (Chunk 12), so both close a target's open
 * reports the same way, inside the caller's transaction.
 */
@Injectable()
export class ReportsStore {
  constructor(
    @InjectModel(Report.name)
    private readonly reportModel: Model<ReportDocument>,
  ) {}

  /**
   * Closes every open report on a target.
   *
   * @returns how many were closed
   */
  async resolveOpen(
    targetType: ReportTargetType,
    targetId: string,
    resolution: ReportResolution,
    adminId: string,
    session: ClientSession,
  ): Promise<number> {
    const result = await this.reportModel
      .updateMany(
        { status: 'open', targetType, targetId },
        {
          $set: {
            status: 'resolved',
            resolution,
            resolvedBy: adminId,
            resolvedAt: new Date(),
          },
        },
        { session },
      )
      .exec();
    return result.modifiedCount;
  }
}
