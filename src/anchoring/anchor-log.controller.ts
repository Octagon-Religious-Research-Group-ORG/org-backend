import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Query,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import type { Response } from 'express';
import { AnchorLogService, type ProofRefusal } from './anchor-log.service';
import { AnchorScheduler } from './anchor-scheduler.service';
import {
  ConsistencyProofQueryDto,
  EntriesQueryDto,
  InclusionProofQueryDto,
} from './anchor-log.dto';

/**
 * Each answer reads the whole log (one entry a day): rationed like the
 * receipts (Chunk 16). The publication job asks twice a day at most.
 */
export const ANCHOR_LOG_THROTTLE = { ttl: seconds(60), limit: 20 };

/** Signed checkpoints and proofs are public and change at most hourly. */
const PUBLIC_CACHE = 'public, max-age=60';

export const LOG_UNSIGNED =
  'The anchor log has no signed checkpoint on this server: its checkpoints are unsigned, so nothing here can be checked against it yet.';
const INCONSISTENT =
  "This server's copy of the anchor log does not hold together; no proof is given from it.";

function failed(result: ProofRefusal): never {
  if (result.error === 'inconsistent')
    throw new ConflictException(INCONSISTENT);
  if (result.error === 'not-found') {
    throw new NotFoundException('That day is not in the anchor log.');
  }
  throw new BadRequestException('Those sizes are outside the anchor log.');
}

/**
 * The daily anchor log, public and read-only (Chunk 16b): the latest signed
 * checkpoint in the C2SP text format, inclusion and consistency proofs, and
 * its status. Nothing here is personal: day records hold only hashes and
 * counts. A reader never has to trust these answers; every one is checked
 * against the published checkpoint and the log's public key.
 */
@Controller('anchors')
@Throttle({ default: ANCHOR_LOG_THROTTLE })
export class AnchorLogController {
  constructor(
    private readonly log: AnchorLogService,
    private readonly scheduler: AnchorScheduler,
  ) {}

  /** `text/plain`: the signed note exactly (c2sp.org/tlog-checkpoint). */
  @Get('checkpoint')
  async checkpoint(@Res({ passthrough: true }) response: Response) {
    const answer = await this.log.checkpoint();
    if (!answer.signed) {
      response.setHeader('Cache-Control', 'no-store');
      throw new ServiceUnavailableException({
        message: LOG_UNSIGNED,
        signed: false,
        origin: this.log.settings.origin,
        size: answer.size,
        root: answer.root,
        reasons: answer.reasons,
      });
    }
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', PUBLIC_CACHE);
    return answer.note;
  }

  /** The log's state: its key, size, and how it stands against publication. */
  @Get('log')
  async status(@Res({ passthrough: true }) response: Response) {
    this.log.beginCheck();
    const [answer, view] = await Promise.all([
      this.log.checkpoint(),
      this.log.view(),
    ]);
    response.setHeader('Cache-Control', PUBLIC_CACHE);
    return {
      origin: this.log.settings.origin,
      verifierKey: this.log.settings.verifierKey ?? null,
      size: view.size,
      signed: answer.signed,
      signedSize: answer.signed ? answer.size : null,
      // The run every start makes: the publication job waits for it (L1).
      startup: this.scheduler.startup(),
      publishedSize: view.published?.size ?? null,
      check: view.check,
      // Set until the owner removes it after the first publication (L1).
      bootstrap: view.bootstrap,
      notes: this.log.settings.notes,
    };
  }

  @Get('proof/inclusion')
  async inclusion(
    @Query() query: InclusionProofQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.log.inclusion(query.day, query.size);
    if ('error' in result) failed(result);
    response.setHeader('Cache-Control', PUBLIC_CACHE);
    return result;
  }

  /** The day records of a range, so a copy can rebuild the log (M2a). */
  @Get('entries')
  async entries(
    @Query() query: EntriesQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.log.entries(query.from, query.to);
    if ('error' in result) failed(result);
    response.setHeader('Cache-Control', PUBLIC_CACHE);
    return result;
  }

  @Get('proof/consistency')
  async consistency(
    @Query() query: ConsistencyProofQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.log.consistency(query.from, query.to);
    if ('error' in result) failed(result);
    response.setHeader('Cache-Control', PUBLIC_CACHE);
    return result;
  }
}
