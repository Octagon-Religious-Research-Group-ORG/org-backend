import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AdminRoleGuard } from '../auth/admin-role.guard';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { WriteThrottle } from '../config/throttle';
import { NoStoreWhenSignedInInterceptor } from '../members/no-store.interceptor';
import { AnchorScheduler } from './anchor-scheduler.service';
import { AnchorsQueryDto } from './anchoring.dto';
import {
  type AnchorReport,
  AnchorVerifierService,
} from './anchor-verifier.service';
import { AnchoringService } from './anchoring.service';
import {
  TimestampAnchor,
  type TimestampAnchorDocument,
} from './schemas/timestamp-anchor.schema';

export const ANCHORING_OFF =
  'Timestamp anchoring is switched off on this server (ANCHORING_ENABLED=false).';

/** One anchor row as the admin dashboard lists it: never the leaf list. */
export interface AnchorRowView {
  anchorId: string;
  status: string;
  builtAt?: string;
  leaves: number;
  merkleRoot?: string;
  tsa: {
    status?: string;
    attempts: number;
    genTime?: string;
    nextAttemptAt?: string;
    lastError?: string;
  };
  ots: {
    status?: string;
    attempts: number;
    calendars: Array<{ url: string; ok: boolean; error?: string }>;
    bitcoinHeights: number[];
    lastUpgradeAt?: string;
    nextAttemptAt?: string;
    lastError?: string;
  };
  verify: AnchorReport;
}

function iso(value: Date | null | undefined) {
  return value ? value.toISOString() : undefined;
}

function text(value: string | null | undefined) {
  return value ?? undefined;
}

/**
 * The admin dashboard's Anchors view (Chunk 16): every anchor, each
 * provider's state, and every check re-run on each read, each with its own
 * pass / fail / cannot-measure.
 */
@Controller('admin/anchors')
@UseGuards(ClerkAuthGuard, AdminRoleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class AdminAnchorsController {
  constructor(
    @InjectModel(TimestampAnchor.name)
    private readonly anchorModel: Model<TimestampAnchorDocument>,
    private readonly verifier: AnchorVerifierService,
    private readonly anchoring: AnchoringService,
    private readonly scheduler: AnchorScheduler,
  ) {}

  @Get()
  async list(@Query() query: AnchorsQueryDto) {
    const health = await this.verifier.verifyAll(new Date(), query.page ?? 1);
    const rows = (await this.anchorModel
      .find({ _id: { $in: health.anchors.map((a) => a.anchorId) } })
      .sort({ _id: -1 })
      .select({ leaves: 0, 'tsa.response': 0, 'ots.proof': 0 })
      .lean()
      .exec()) as TimestampAnchor[];
    const reports = new Map(health.anchors.map((r) => [r.anchorId, r]));
    const anchors: AnchorRowView[] = rows.map((row) => ({
      anchorId: row._id,
      status: row.status,
      builtAt: iso(row.builtAt),
      leaves: (reports.get(row._id) as AnchorReport).leaves,
      merkleRoot: row.merkleRoot,
      tsa: {
        status: row.tsa?.status,
        attempts: row.tsa?.attempts ?? 0,
        genTime: iso(row.tsa?.genTime),
        nextAttemptAt: iso(row.tsa?.nextAttemptAt),
        lastError: text(row.tsa?.lastError),
      },
      ots: {
        status: row.ots?.status,
        attempts: row.ots?.attempts ?? 0,
        calendars: (row.ots?.calendars ?? []).map((c) => ({
          url: c.url,
          ok: c.ok,
          ...(c.error ? { error: c.error } : {}),
        })),
        bitcoinHeights: row.ots?.bitcoinHeights ?? [],
        lastUpgradeAt: iso(row.ots?.lastUpgradeAt),
        nextAttemptAt: iso(row.ots?.nextAttemptAt),
        lastError: text(row.ots?.lastError),
      },
      verify: reports.get(row._id) as AnchorReport,
    }));
    return {
      enabled: this.anchoring.enabled,
      checkedAt: health.checkedAt,
      page: health.page,
      hasMore: health.hasMore,
      coverage: health.coverage,
      totalsScope: health.totalsScope,
      totals: health.totals,
      global: health.global,
      anchors,
    };
  }

  /** Runs what is due now; today's anchor without waiting for its hour. */
  @Post('run')
  @HttpCode(200)
  @WriteThrottle()
  async runNow() {
    if (!this.anchoring.enabled) throw new ConflictException(ANCHORING_OFF);
    return this.scheduler.runNow();
  }
}
