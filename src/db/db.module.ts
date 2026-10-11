import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ModerationLogEntry,
  ModerationLogEntrySchema,
} from '../moderation/schemas/moderation-log.schema';
import {
  BlockVersion,
  BlockVersionSchema,
} from '../social/schemas/block-version.schema';
import {
  ProfileBlock,
  ProfileBlockSchema,
} from '../social/schemas/profile-block.schema';
import {
  SocialProfile,
  SocialProfileSchema,
} from '../social/schemas/social-profile.schema';
import { ManagedIndexesService } from './managed-indexes.service';

/** Index management for the collections with `autoIndex: false`. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SocialProfile.name, schema: SocialProfileSchema },
      { name: ProfileBlock.name, schema: ProfileBlockSchema },
      { name: BlockVersion.name, schema: BlockVersionSchema },
      { name: ModerationLogEntry.name, schema: ModerationLogEntrySchema },
    ]),
  ],
  providers: [ManagedIndexesService],
})
export class DbModule {}
