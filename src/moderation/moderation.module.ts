import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ModerationLogService } from './moderation-log.service';
import {
  ModerationLogEntry,
  ModerationLogEntrySchema,
} from './schemas/moderation-log.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ModerationLogEntry.name, schema: ModerationLogEntrySchema },
    ]),
  ],
  providers: [ModerationLogService],
  exports: [ModerationLogService],
})
export class ModerationModule {}
