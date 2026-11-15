import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  addBlockVersion,
  anchorLogFor,
  anchorModels,
  LOG_KEY,
  offlineAnchoring,
} from './anchoring-harness.mocks-spec';
import {
  ANCHOR_LOG_THROTTLE,
  AnchorLogController,
  LOG_UNSIGNED,
} from './anchor-log.controller';
import {
  ConsistencyProofQueryDto,
  EntriesQueryDto,
  InclusionProofQueryDto,
} from './anchor-log.dto';
import { openNote, parseVerifier } from './signed-note';
import { makeTestTsa } from './test-tsa.mocks-spec';

const NOW = new Date('2026-11-14T04:00:00Z');
const tsa = makeTestTsa();

function response() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  };
}

async function setUp(env?: Record<string, string | undefined>) {
  jest.spyOn(Logger.prototype, 'log').mockImplementation();
  const m = anchorModels();
  addBlockVersion(m);
  await offlineAnchoring(m, tsa).run(NOW);
  addBlockVersion(m, { createdAt: new Date('2026-11-14T10:00:00Z') });
  await offlineAnchoring(m, tsa).run(new Date('2026-11-15T04:00:00Z'));
  const logged = anchorLogFor(m, tsa, env);
  await logged.log.append(new Date('2026-11-15T05:00:00Z'));
  const scheduler = {
    startup: () => ({ state: 'done', finishedAt: '2026-11-15T05:00:00.000Z' }),
  };
  return {
    m,
    logged,
    controller: new AnchorLogController(logged.log, scheduler as never),
  };
}

describe('AnchorLogController', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is rationed like the receipts', () => {
    expect(ANCHOR_LOG_THROTTLE.limit).toBe(20);
  });

  it('serves the signed checkpoint as plain C2SP text, cacheable', async () => {
    const { controller } = await setUp();
    const res = response();
    const note = await controller.checkpoint(res as never);
    expect(res.headers['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['Cache-Control']).toBe('public, max-age=60');
    expect(openNote(note, parseVerifier(LOG_KEY.verifierKey)).ok).toBe(true);
  });

  it('says plainly when checkpoints are unsigned: 503, never a checkpoint', async () => {
    const { controller } = await setUp({});
    const res = response();
    const error = await controller
      .checkpoint(res as never)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      message: LOG_UNSIGNED,
      signed: false,
      size: 2,
    });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('reports its status, key and publication check', async () => {
    const { controller, logged } = await setUp();
    let status = await controller.status(response() as never);
    expect(status).toMatchObject({
      verifierKey: LOG_KEY.verifierKey,
      size: 2,
      signed: true,
      signedSize: 2,
      // L1: the publication job waits for this before it fetches.
      startup: { state: 'done', finishedAt: '2026-11-15T05:00:00.000Z' },
      publishedSize: null,
      check: { outcome: 'cannot-measure' },
      // Review round 3, L1: the page warns while the flag is set.
      bootstrap: true,
    });
    logged.publishLatest();
    status = await controller.status(response() as never);
    expect(status).toMatchObject({
      publishedSize: 2,
      check: { outcome: 'pass' },
      bootstrap: false,
    });
    const unsigned = await setUp({});
    expect(await unsigned.controller.status(response() as never)).toMatchObject(
      { verifierKey: null, signed: false, signedSize: null },
    );
  });

  it('gives proofs, and maps every refusal to its status', async () => {
    const { controller, m } = await setUp();
    const res = response();
    expect(
      await controller.inclusion({ day: '2026-11-14' }, res as never),
    ).toMatchObject({ index: 0, size: 2 });
    expect(res.headers['Cache-Control']).toBe('public, max-age=60');
    expect(
      await controller.consistency({ from: 1, to: 2 }, response() as never),
    ).toMatchObject({ from: 1, to: 2 });
    await expect(
      controller.inclusion({ day: '2020-01-01' }, response() as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      controller.consistency({ from: 2, to: 9 }, response() as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    m.logLeaves!.docs[0].hash = '0'.repeat(64);
    await expect(
      controller.consistency({ from: 1, to: 2 }, response() as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('validates and bounds its inputs', () => {
    const errors = (cls: new () => object, raw: Record<string, unknown>) =>
      validateSync(plainToInstance(cls, raw)).length;
    expect(errors(InclusionProofQueryDto, { day: '2026-11-14' })).toBe(0);
    expect(
      errors(InclusionProofQueryDto, { day: '2026-11-14', size: '3' }),
    ).toBe(0);
    for (const raw of [
      { day: 'x' },
      { day: '2026-11-14', size: '0' },
      { day: '2026-11-14', size: '1000001' },
      { day: '2026-11-14', size: '1.5' },
    ]) {
      expect(errors(InclusionProofQueryDto, raw)).toBeGreaterThan(0);
    }
    expect(errors(ConsistencyProofQueryDto, { from: '1', to: '2' })).toBe(0);
    for (const raw of [{}, { from: '0', to: '2' }, { from: '1' }]) {
      expect(errors(ConsistencyProofQueryDto, raw)).toBeGreaterThan(0);
    }
  });

  it('M2a: serves the day records of a range, cacheable, and validates it', async () => {
    const { controller } = await setUp();
    const res = response();
    const answer = await controller.entries({ from: 0, to: 2 }, res as never);
    expect(answer).toMatchObject({ from: 0, to: 2 });
    expect((answer as { records: string[] }).records).toHaveLength(2);
    expect(res.headers['Cache-Control']).toBe('public, max-age=60');
    await expect(
      controller.entries({ from: 1, to: 5 }, response() as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    const errors = (raw: Record<string, unknown>) =>
      validateSync(plainToInstance(EntriesQueryDto, raw)).length;
    expect(errors({ from: '0', to: '2' })).toBe(0);
    for (const raw of [
      {},
      { from: '-1', to: '2' },
      { from: '0', to: '1000001' },
    ]) {
      expect(errors(raw)).toBeGreaterThan(0);
    }
  });
});
