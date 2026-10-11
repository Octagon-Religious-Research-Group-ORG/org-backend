import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import {
  formatIndexOutcome,
  type IndexedModel,
  reconcileIndexes,
} from './index-setup';
import { MANAGED_SCHEMAS } from './managed-schemas';

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
    @InjectConnection() private readonly connection: Connection,
  ) {
    this.mode = config.get<IndexMode>('MANAGE_INDEXES', 'check');
  }

  async onApplicationBootstrap() {
    const dryRun = this.mode !== 'create';
    const models: IndexedModel[] = MANAGED_SCHEMAS.map(({ name }) =>
      this.connection.model(name),
    );
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
