import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BlockVersionsService } from './block-versions.service';
import { CommentVersionsService } from './comment-versions.service';
import {
  BlockVersion,
  BlockVersionSchema,
} from './schemas/block-version.schema';
import {
  CommentVersion,
  CommentVersionSchema,
} from './schemas/comment-version.schema';
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
 * hash-chained history of every paragraph and every site comment.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SocialProfile.name, schema: SocialProfileSchema },
      { name: ProfileBlock.name, schema: ProfileBlockSchema },
      { name: BlockVersion.name, schema: BlockVersionSchema },
      { name: CommentVersion.name, schema: CommentVersionSchema },
    ]),
  ],
  providers: [BlockVersionsService, CommentVersionsService],
  exports: [BlockVersionsService, CommentVersionsService],
})
export class SocialModule {}
