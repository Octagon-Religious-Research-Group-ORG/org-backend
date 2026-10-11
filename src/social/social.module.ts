import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BlockVersionsService } from './block-versions.service';
import {
  BlockVersion,
  BlockVersionSchema,
} from './schemas/block-version.schema';
import {
  ProfileBlock,
  ProfileBlockSchema,
} from './schemas/profile-block.schema';
import {
  SocialProfile,
  SocialProfileSchema,
} from './schemas/social-profile.schema';

/**
 * Members-area profiles: public pages, their paragraphs and the append-only,
 * hash-chained history of every paragraph.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SocialProfile.name, schema: SocialProfileSchema },
      { name: ProfileBlock.name, schema: ProfileBlockSchema },
      { name: BlockVersion.name, schema: BlockVersionSchema },
    ]),
  ],
  providers: [BlockVersionsService],
  exports: [BlockVersionsService],
})
export class SocialModule {}
