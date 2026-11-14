import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EmailBudgetStore } from '../member-notifications/email-budget.store';
import {
  EmailBudgetDay,
  EmailBudgetDaySchema,
} from '../member-notifications/schemas/email-budget.schema';
import { NotificationsService } from './notifications.service';

/**
 * Outbound email. The daily email budget lives here (Chunk 14 review L10),
 * so offering-order emails are counted in the same day as notifications.
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EmailBudgetDay.name, schema: EmailBudgetDaySchema },
    ]),
  ],
  providers: [NotificationsService, EmailBudgetStore],
  exports: [NotificationsService, EmailBudgetStore],
})
export class NotificationsModule {}
