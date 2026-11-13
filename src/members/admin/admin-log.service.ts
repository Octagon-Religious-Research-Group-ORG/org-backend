import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import {
  ModerationLogEntry,
  type ModerationLogEntryDocument,
} from '../../moderation/schemas/moderation-log.schema';
import {
  SocialProfile,
  type SocialProfileDocument,
} from '../../social/schemas/social-profile.schema';

export const LOG_PAGE_SIZE = 50;

/** One moderation-log entry as the dashboard shows it (admins only). */
export interface LogEntryView {
  entryId: string;
  at: string;
  actorUserId: string;
  /** The actor's member-page name, when they have a page. */
  actorName?: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
  details?: Record<string, unknown>;
}

interface LogRow {
  _id: Types.ObjectId;
  at: Date;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
  details?: Record<string, unknown>;
}

/**
 * The moderation log, newest first, read-only (Chunk 12). Nothing here can
 * write it: the log is append-only at the schema, and this service only reads.
 */
@Injectable()
export class AdminLogService {
  constructor(
    @InjectModel(ModerationLogEntry.name)
    private readonly logModel: Model<ModerationLogEntryDocument>,
    @InjectModel(SocialProfile.name)
    private readonly profileModel: Model<SocialProfileDocument>,
  ) {}

  async page(
    page: number,
  ): Promise<{ entries: LogEntryView[]; hasMore: boolean }> {
    const rows = (await this.logModel
      .find({})
      .sort({ at: -1, _id: -1 })
      .skip((page - 1) * LOG_PAGE_SIZE)
      .limit(LOG_PAGE_SIZE + 1)
      .lean()
      .exec()) as unknown as LogRow[];
    const shown = rows.slice(0, LOG_PAGE_SIZE);
    const actors = [...new Set(shown.map((row) => row.actorUserId))];
    const pages =
      actors.length === 0
        ? []
        : await this.profileModel
            .find({
              ownerUserId: { $in: actors },
              reviewStatus: { $ne: 'claiming' },
            })
            .select({ ownerUserId: 1, displayName: 1 })
            .lean()
            .exec();
    const nameOf = new Map(
      pages.map((page) => [page.ownerUserId, page.displayName]),
    );
    return {
      entries: shown.map((row) => {
        const actorName = nameOf.get(row.actorUserId);
        return {
          entryId: String(row._id),
          at: row.at.toISOString(),
          actorUserId: row.actorUserId,
          ...(actorName ? { actorName } : {}),
          action: row.action,
          targetType: row.targetType,
          targetId: row.targetId,
          reason: row.reason,
          ...(row.details ? { details: row.details } : {}),
        };
      }),
      hasMore: rows.length > LOG_PAGE_SIZE,
    };
  }
}
