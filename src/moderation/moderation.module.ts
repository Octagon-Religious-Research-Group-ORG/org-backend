import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ModerationLogService } from './moderation-log.service';
import { ReportsStore } from './reports.store';
import {
  ModerationLogEntry,
  ModerationLogEntrySchema,
} from './schemas/moderation-log.schema';
import { Report, ReportSchema } from './schemas/report.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ModerationLogEntry.name, schema: ModerationLogEntrySchema },
      { name: Report.name, schema: ReportSchema },
    ]),
  ],
  providers: [ModerationLogService, ReportsStore],
  exports: [ModerationLogService, ReportsStore],
})
export class ModerationModule {}
