import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConnectionRecords } from './connection-records.service';

/** How often unanswered requests are checked for expiry. */
export const EXPIRY_TICK_MS = 60 * 60_000;

/**
 * Expires requests nobody answered within 90 days, like the other in-app
 * jobs (`MemberPurgeScheduler`): once at start, then hourly; the timer is
 * `unref`'d. Every read or write that depends on it also expires the
 * records it touches first, so a missed tick never shows a stale request.
 */
@Injectable()
export class ConnectionExpiryScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ConnectionExpiryScheduler.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly records: ConnectionRecords) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.tick(), EXPIRY_TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One sweep; a failure is logged, never thrown. */
  async tick(now = new Date()) {
    try {
      await this.records.expireStale(now);
    } catch (error) {
      this.logger.error(
        `Expiring connection requests failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
