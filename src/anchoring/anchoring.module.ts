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
      { name: BlockVersion.name, schema: BlockVersionSchema },
      { name: CommentVersion.name, schema: CommentVersionSchema },
    ]),
  ],
  controllers: [AdminAnchorsController],
  providers: [
    TsaProvider,
    OtsProvider,
    AnchoringService,
    AnchorVerifierService,
    AnchorScheduler,
  ],
  exports: [AnchorVerifierService],
})
export class AnchoringModule {}
