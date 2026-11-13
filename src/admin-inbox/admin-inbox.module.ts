import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ModerationModule } from '../moderation/moderation.module';
import {
  SocialProfile,
  SocialProfileSchema,
} from '../social/schemas/social-profile.schema';
import { AdminInboxService } from './admin-inbox.service';
import {
  AdminInboxEntry,
  AdminInboxEntrySchema,
} from './schemas/admin-inbox.schema';

/**
 * The admins' inbox (Chunk 12): used by joining (a new page waits for
 * approval) and by the admin dashboard and the "Request EaM" button.
 */
@Module({
  imports: [
    ModerationModule,
    MongooseModule.forFeature([
      { name: AdminInboxEntry.name, schema: AdminInboxEntrySchema },
      { name: SocialProfile.name, schema: SocialProfileSchema },
    ]),
  ],
  providers: [AdminInboxService],
  exports: [AdminInboxService],
})
export class AdminInboxModule {}
