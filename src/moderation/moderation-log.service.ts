import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
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

  record(entry: NewModerationLogEntry) {
    return this.logModel.create({ ...entry, at: new Date() });
  }
}
