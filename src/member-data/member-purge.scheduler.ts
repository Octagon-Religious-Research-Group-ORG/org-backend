import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  MemberPurgeService,
  type PurgeRunReport,
} from './member-purge.service';

/** How often the in-app tick looks while the server is awake. */
export const PURGE_TICK_MS = 60 * 60_000;

/**
 * Runs the daily purge without an external scheduler, like the anchoring
 * job (Chunk 16): once at start (Render's free instance sleeps, so every
 * wake catches up), then hourly; the run itself does a day's work once.
 * The timer is `unref`'d so it never keeps a process alive.
 */
@Injectable()
export class MemberPurgeScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MemberPurgeScheduler.name);
  private timer?: ReturnType<typeof setInterval>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly purge: MemberPurgeService) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.tick(), PURGE_TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One run after the previous one; a failure is logged, never thrown. */
  tick(now?: Date): Promise<PurgeRunReport | undefined> {
    const next = this.chain.then(() => this.purge.run(now ?? new Date()));
    this.chain = next.catch(() => undefined);
    return next.catch((error: unknown) => {
      this.logger.error(
        `Five-year purge failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    });
  }
}
