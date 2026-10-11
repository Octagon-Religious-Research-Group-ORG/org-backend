import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  formatIndexOutcome,
  type IndexedModel,
  reconcileIndexes,
} from '../db/index-setup';
import { BlockVersion } from './schemas/block-version.schema';
import { ProfileBlock } from './schemas/profile-block.schema';
import { SocialProfile } from './schemas/social-profile.schema';

export type IndexMode = 'check' | 'create';

/**
 * Checks the members-area indexes when the server starts and, only when
 * `MANAGE_INDEXES=create`, creates the declared ones that are missing.
 *
 * `check` (the default) changes nothing. Either way a missing or undeclared
 * index is logged as an error, so it is visible in the host's logs instead of
 * surfacing later as a duplicate or a slow query. Startup is never blocked.
 */
@Injectable()
export class SocialIndexesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SocialIndexesService.name);
  private readonly mode: IndexMode;

  constructor(
    config: ConfigService,
    @InjectModel(SocialProfile.name) private readonly profiles: Model<unknown>,
    @InjectModel(ProfileBlock.name) private readonly blocks: Model<unknown>,
    @InjectModel(BlockVersion.name) private readonly versions: Model<unknown>,
  ) {
    this.mode = config.get<IndexMode>('MANAGE_INDEXES', 'check');
  }

  async onApplicationBootstrap() {
    const dryRun = this.mode !== 'create';
    const models: IndexedModel[] = [this.profiles, this.blocks, this.versions];
    const outcome = await reconcileIndexes(models, { dryRun });
    const lines = formatIndexOutcome(outcome, dryRun);

    if (outcome.status === 'ok') {
      this.logger.log(`Members-area indexes OK (${this.mode}).`);
      return;
    }
    for (const line of lines) {
      this.logger.error(`Members-area indexes (${this.mode}): ${line}`);
    }
  }
}
