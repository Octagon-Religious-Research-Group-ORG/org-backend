import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

/** What the startup check found. */
export type ReplicaSetStatus = 'replica-set' | 'standalone' | 'unknown';

export const STANDALONE_WARNING =
  'The database is not a replica set: claim decisions (Chunk 11) need transactions and will answer 503. Use a replica set (Atlas always is one; locally start mongod with --replSet rs0, run rs.initiate(), and add ?replicaSet=rs0 to MONGODB_URI).';

/**
 * Says at startup, once and plainly, when the database cannot run
 * transactions (review round 2). It never stops the server: everything but
 * claim decisions works on a standalone database, and taking the whole site
 * down for one feature would be worse.
 */
@Injectable()
export class ReplicaSetCheckService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReplicaSetCheckService.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  async onApplicationBootstrap() {
    await this.check();
  }

  /** @returns what it found; a failed check is `unknown`, also logged */
  async check(): Promise<ReplicaSetStatus> {
    try {
      const hello = (await this.connection.db
        ?.admin()
        .command({ hello: 1 })) as
        | { setName?: string; msg?: string }
        | undefined;
      if (!hello) throw new Error('not connected');
      if (hello.setName || hello.msg === 'isdbgrid') return 'replica-set';
      this.logger.warn(STANDALONE_WARNING);
      return 'standalone';
    } catch (error) {
      this.logger.warn(
        `Could not check whether the database is a replica set: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'unknown';
    }
  }
}
