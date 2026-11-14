import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AnchoringService, type RunReport } from './anchoring.service';

/** How often the in-app tick runs while the server is awake. */
export const ANCHOR_TICK_MS = 60 * 60_000;

/**
 * Runs the daily anchor without an external scheduler (Chunk 16), like the
 * email digest (Chunk 14): once when the server starts, because Render's
 * free instance sleeps and every wake must catch up, then hourly. The timer
 * is `unref`'d so it never keeps a process alive.
 *
 * Runs never overlap: the run lock in `anchorrunlocks` (review round 7)
 * lets one run at a time execute, across every caller and instance; a
 * second one reports `busy`. Within one process runs are also queued here.
 * The per-anchor leases remain as a second line.
 */
@Injectable()
export class AnchorScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AnchorScheduler.name);
  private timer?: ReturnType<typeof setInterval>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly anchoring: AnchoringService) {}

  onApplicationBootstrap() {
    if (!this.anchoring.enabled) {
      this.logger.warn(
        'Timestamp anchoring is off (ANCHORING_ENABLED=false): no version is anchored.',
      );
      return;
    }
    this.timer = setInterval(() => void this.tick(), ANCHOR_TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One run after the previous one; a failure is logged, never thrown. */
  tick(now?: Date): Promise<RunReport | undefined> {
    return this.queue(now ?? new Date(), false).catch((error: unknown) => {
      this.logger.error(
        `Anchoring run failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    });
  }

  /**
   * The admin's "run now": today's anchor without waiting for the hour (still
   * one a day), then every step due. Its failure reaches the caller.
   */
  runNow(now = new Date()): Promise<RunReport> {
    return this.queue(now, true);
  }

  private queue(now: Date, force: boolean): Promise<RunReport> {
    const next = this.chain.then(() => this.anchoring.run(now, force));
    this.chain = next.catch(() => undefined);
    return next;
  }
}
