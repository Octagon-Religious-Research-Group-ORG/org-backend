import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ModerationLogService } from './moderation-log.service';
import { ReportQuotaStore } from './report-quota.store';
import { ReportsStore } from './reports.store';
import {
  ModerationLogEntry,
  ModerationLogEntrySchema,
} from './schemas/moderation-log.schema';
import { Report, ReportSchema } from './schemas/report.schema';
import { ReportQuota, ReportQuotaSchema } from './schemas/report-quota.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ModerationLogEntry.name, schema: ModerationLogEntrySchema },
      { name: Report.name, schema: ReportSchema },
      { name: ReportQuota.name, schema: ReportQuotaSchema },
    ]),
  ],
  providers: [ModerationLogService, ReportsStore, ReportQuotaStore],
  exports: [ModerationLogService, ReportsStore, ReportQuotaStore],
})
export class ModerationModule {}
