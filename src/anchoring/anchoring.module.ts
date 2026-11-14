import {
  AccountDeletion,
  AccountDeletionSchema,
} from '../member-data/schemas/account-deletion.schema';
import {
  BeliefTab,
  BeliefTabSchema,
} from '../social/schemas/belief-tab.schema';
import { Comment, CommentSchema } from '../social/schemas/comment.schema';
import {
  ProfileBlock,
  ProfileBlockSchema,
} from '../social/schemas/profile-block.schema';
import {
  SocialProfile,
  SocialProfileSchema,
} from '../social/schemas/social-profile.schema';
import { PurgeMarksService } from './purge-marks.service';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  BlockVersion,
  BlockVersionSchema,
} from '../social/schemas/block-version.schema';
import {
  CommentVersion,
  CommentVersionSchema,
} from '../social/schemas/comment-version.schema';
import { AnchorScheduler } from './anchor-scheduler.service';
import { AnchorVerifierService } from './anchor-verifier.service';
import { AdminAnchorsController } from './anchoring.controller';
import { AnchoringService } from './anchoring.service';
import { OtsProvider, TsaProvider } from './providers';
import { AnchorLeaf, AnchorLeafSchema } from './schemas/anchor-leaf.schema';
import {
  AnchorRunLock,
  AnchorRunLockSchema,
} from './schemas/anchor-run-lock.schema';
import {
  TimestampAnchor,
  TimestampAnchorSchema,
} from './schemas/timestamp-anchor.schema';

/**
 * Timestamps that hold up (plan §6, D8, Chunk 16): the daily Merkle anchor
 * of every belief and comment version, its FreeTSA and OpenTimestamps
 * proofs, and their verification. Receipts are built in the members module,
 * which owns who may read what.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TimestampAnchor.name, schema: TimestampAnchorSchema },
      { name: AnchorLeaf.name, schema: AnchorLeafSchema },
      { name: AnchorRunLock.name, schema: AnchorRunLockSchema },
      { name: BlockVersion.name, schema: BlockVersionSchema },
      { name: CommentVersion.name, schema: CommentVersionSchema },
      // Read only: whether a purged version's owner is marked (Chunk 17).
      { name: SocialProfile.name, schema: SocialProfileSchema },
      { name: ProfileBlock.name, schema: ProfileBlockSchema },
      { name: BeliefTab.name, schema: BeliefTabSchema },
      { name: Comment.name, schema: CommentSchema },
      // Read only: the purge run a redaction record belongs to (round 3).
      { name: AccountDeletion.name, schema: AccountDeletionSchema },
    ]),
  ],
  controllers: [AdminAnchorsController],
  providers: [
    TsaProvider,
    OtsProvider,
    AnchoringService,
    AnchorVerifierService,
    PurgeMarksService,
    AnchorScheduler,
  ],
  exports: [AnchorVerifierService],
})
export class AnchoringModule {}
