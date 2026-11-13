import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import {
  ModerationLogEntry,
  type ModerationLogEntryDocument,
} from './schemas/moderation-log.schema';

export type NewModerationLogEntry = Omit<ModerationLogEntry, 'at'>;

/** Writes the append-only moderation log; the time is always the server's. */
@Injectable()
export class ModerationLogService {
  constructor(
    @InjectModel(ModerationLogEntry.name)
    private readonly logModel: Model<ModerationLogEntryDocument>,
  ) {}

  /**
   * @param session - write inside this transaction, so the entry exists if
   *   and only if the change it records does (Chunk 11 claims)
   */
  async record(entry: NewModerationLogEntry, session?: ClientSession) {
    const row = { ...entry, at: new Date() };
    if (!session) return this.logModel.create(row);
    const [written] = await this.logModel.create([row], { session });
    return written;
  }
}
