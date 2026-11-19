import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MANAGED_SCHEMAS } from '../db/managed-schemas';
import { ConnectionsModule } from '../connections/connections.module';
import { MembersModule } from '../members/members.module';
import { ModerationModule } from '../moderation/moderation.module';
import { ClerkWebhookController } from './clerk-webhook.controller';
import {
  AdminDeletedPagesController,
  AdminDeletedPageWritesController,
  ExportThrottleGuard,
  MyDataController,
  MyDataWritesController,
} from './member-data.controller';
import { MemberExportService } from './member-export.service';
import { MemberPurgeScheduler } from './member-purge.scheduler';
import { MemberPurgeService } from './member-purge.service';
import { MemberWriteThrottleGuard } from '../members/member-write-throttle.guard';
import { PageDeletionService } from './page-deletion.service';

/**
 * Data export and page deletion (Chunk 17): "Download my data", "Delete my
 * page" with its undo, the admins' deleted-pages view, Clerk's
 * `user.deleted` webhook, and the automatic purge five years after a
 * deletion (plan §2b D22). Reads every collection that can hold a member's
 * data, so it registers the managed list whole.
 */
@Module({
  imports: [
    MembersModule,
    // Connection requests end, export and purge with the member (Chunk 18).
    ConnectionsModule,
    ModerationModule,
    MongooseModule.forFeature([...MANAGED_SCHEMAS]),
  ],
  controllers: [
    MyDataController,
    MyDataWritesController,
    AdminDeletedPagesController,
    AdminDeletedPageWritesController,
    ClerkWebhookController,
  ],
  providers: [
    PageDeletionService,
    MemberExportService,
    MemberPurgeService,
    MemberPurgeScheduler,
    ExportThrottleGuard,
    MemberWriteThrottleGuard,
  ],
})
export class MemberDataModule {}
