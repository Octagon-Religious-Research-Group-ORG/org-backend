import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  formatIndexOutcome,
  type IndexedModel,
  reconcileIndexes,
} from './index-setup';
import { ModerationLogEntry } from '../moderation/schemas/moderation-log.schema';
import { BlockVersion } from '../social/schemas/block-version.schema';
import { ProfileBlock } from '../social/schemas/profile-block.schema';
import { SocialProfile } from '../social/schemas/social-profile.schema';

export type IndexMode = 'check' | 'create';

/**
 * Checks the indexes of every collection that opts out of auto-indexing when the server starts and, only when
 * `MANAGE_INDEXES=create`, creates the declared ones that are missing.
 *
 * `check` (the default) changes nothing. Either way a missing or undeclared
 * index is logged as an error, so it is visible in the host's logs instead of
 * surfacing later as a duplicate or a slow query. Startup is never blocked.
 */
@Injectable()
export class ManagedIndexesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ManagedIndexesService.name);
  private readonly mode: IndexMode;

  constructor(
    config: ConfigService,
    @InjectModel(SocialProfile.name) private readonly profiles: Model<unknown>,
    @InjectModel(ProfileBlock.name) private readonly blocks: Model<unknown>,
    @InjectModel(BlockVersion.name) private readonly versions: Model<unknown>,
    @InjectModel(ModerationLogEntry.name)
    private readonly moderationLog: Model<unknown>,
  ) {
    this.mode = config.get<IndexMode>('MANAGE_INDEXES', 'check');
  }

  async onApplicationBootstrap() {
    const dryRun = this.mode !== 'create';
    const models: IndexedModel[] = [
      this.profiles,
      this.blocks,
      this.versions,
      this.moderationLog,
    ];
    const outcome = await reconcileIndexes(models, { dryRun });
    const lines = formatIndexOutcome(outcome, dryRun);

    if (outcome.status === 'ok') {
      this.logger.log(`Managed indexes OK (${this.mode}).`);
      return;
    }
    for (const line of lines) {
      this.logger.error(`Managed indexes (${this.mode}): ${line}`);
    }
  }
}
