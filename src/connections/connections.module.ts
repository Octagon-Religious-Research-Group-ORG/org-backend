import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AccountDeletion,
  AccountDeletionSchema,
} from '../member-data/schemas/account-deletion.schema';
import { MemberNotificationsModule } from '../member-notifications/member-notifications.module';
import { AccountNotDeletedGuard } from '../members/account-not-deleted.guard';
import { MemberWriteThrottleGuard } from '../members/member-write-throttle.guard';
import {
  OrgSetting,
  OrgSettingSchema,
} from '../members/schemas/org-setting.schema';
import { ModerationModule } from '../moderation/moderation.module';
import {
  SocialProfile,
  SocialProfileSchema,
} from '../social/schemas/social-profile.schema';
import { ConnectionExpiryScheduler } from './connection-expiry.scheduler';
import { ConnectionLookups } from './connection-lookups.service';
import { ConnectionRecords } from './connection-records.service';
import { ConnectionTermsService } from './connection-terms.service';
import {
  AdminConnectionTermsController,
  ConnectionTermsController,
  MyConnectionsController,
  MyConnectionWritesController,
} from './connections.controller';
import { ConnectionsService } from './connections.service';
import { ConnectionViews } from './connection-views.service';
import {
  ConnectionBlock,
  ConnectionBlockSchema,
} from './schemas/connection-block.schema';
import {
  ConnectionSettings,
  ConnectionSettingsSchema,
} from './schemas/connection-settings.schema';
import {
  MemberConnection,
  MemberConnectionSchema,
} from './schemas/connection.schema';

/**
 * Connection requests (Chunk 18, plan §2d item 3). Imports neither the
 * members nor the member-data module: both import THIS one (reports on a
 * note, the moderation queue, "Delete my page", the export and the purge),
 * so there is no cycle.
 */
@Module({
  imports: [
    ModerationModule,
    MemberNotificationsModule,
    MongooseModule.forFeature([
      { name: MemberConnection.name, schema: MemberConnectionSchema },
      { name: ConnectionBlock.name, schema: ConnectionBlockSchema },
      { name: ConnectionSettings.name, schema: ConnectionSettingsSchema },
      { name: SocialProfile.name, schema: SocialProfileSchema },
      { name: OrgSetting.name, schema: OrgSettingSchema },
      { name: AccountDeletion.name, schema: AccountDeletionSchema },
    ]),
  ],
  controllers: [
    ConnectionTermsController,
    MyConnectionsController,
    MyConnectionWritesController,
    AdminConnectionTermsController,
  ],
  providers: [
    ConnectionsService,
    ConnectionViews,
    ConnectionLookups,
    ConnectionRecords,
    ConnectionTermsService,
    ConnectionExpiryScheduler,
    AccountNotDeletedGuard,
    MemberWriteThrottleGuard,
  ],
  exports: [ConnectionRecords, ConnectionTermsService],
})
export class ConnectionsModule {}
