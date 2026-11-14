import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AdminInboxEntry,
  AdminInboxEntrySchema,
} from '../admin-inbox/schemas/admin-inbox.schema';
import {
  WebsitePage,
  WebsitePageSchema,
} from '../content/schemas/website-page.schema';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  BeliefTab,
  BeliefTabSchema,
} from '../social/schemas/belief-tab.schema';
import { Comment, CommentSchema } from '../social/schemas/comment.schema';
import {
  SocialProfile,
  SocialProfileSchema,
} from '../social/schemas/social-profile.schema';
import { DigestSender } from './digest-sender';
import { EmailBudgetStore } from './email-budget.store';
import { MemberNotifier } from './member-notifier.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationPrefsService } from './notification-prefs.service';
import { NotificationTargets } from './notification-targets.service';
import {
  AdminNotificationsController,
  MyNotificationSettingsController,
  UnsubscribeController,
} from './notifications.controller';
import {
  EmailBudgetDay,
  EmailBudgetDaySchema,
} from './schemas/email-budget.schema';
import {
  NotificationDigestRow,
  NotificationDigestRowSchema,
} from './schemas/notification-digest.schema';
import {
  NotificationPrefsRow,
  NotificationPrefsRowSchema,
} from './schemas/notification-prefs.schema';
import {
  NotificationQueueRow,
  NotificationQueueRowSchema,
} from './schemas/notification-queue.schema';

/**
 * Member email notifications (Chunk 14): settings, the queue, the daily
 * digest, immediate claim and moderation emails, admin notices, the email
 * budget and unsubscribe links. Imported by the modules whose actions are
 * notified; it imports none of them, so there is no cycle.
 */
@Module({
  imports: [
    NotificationsModule,
    MongooseModule.forFeature([
      { name: NotificationPrefsRow.name, schema: NotificationPrefsRowSchema },
      { name: NotificationQueueRow.name, schema: NotificationQueueRowSchema },
      { name: NotificationDigestRow.name, schema: NotificationDigestRowSchema },
      { name: EmailBudgetDay.name, schema: EmailBudgetDaySchema },
      // Read only: what an email may say and link to.
      { name: Comment.name, schema: CommentSchema },
      { name: SocialProfile.name, schema: SocialProfileSchema },
      { name: BeliefTab.name, schema: BeliefTabSchema },
      { name: WebsitePage.name, schema: WebsitePageSchema },
      // Only its `emailedAt`, once the admins were told.
      { name: AdminInboxEntry.name, schema: AdminInboxEntrySchema },
    ]),
  ],
  controllers: [
    MyNotificationSettingsController,
    UnsubscribeController,
    AdminNotificationsController,
  ],
  providers: [
    NotificationPrefsService,
    NotificationTargets,
    EmailBudgetStore,
    DigestSender,
    NotificationDispatcher,
    MemberNotifier,
  ],
  exports: [MemberNotifier],
})
export class MemberNotificationsModule {}
