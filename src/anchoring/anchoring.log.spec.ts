import { Logger } from '@nestjs/common';
import {
  addBlockVersion,
  anchorLogFor,
  anchorModels,
  offlineAnchoring,
} from './anchoring-harness.mocks-spec';
import type { AnchorLogService } from './anchor-log.service';
import { makeTestTsa } from './test-tsa.mocks-spec';

// Chunk 16b: each anchoring run appends the finished days to the log and
// signs a checkpoint, inside its run lock, BEFORE it asks FreeTSA for the
// day's stamp; and a log that fails never stops the anchoring itself.
const NOW = new Date('2026-11-14T04:00:00Z');
const tsa = makeTestTsa();

describe('AnchoringService and the anchor log', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('a run appends the day it built and signs, before stamping it', async () => {
    const m = anchorModels();
    addBlockVersion(m);
    const { log } = anchorLogFor(m, tsa);
    const order: string[] = [];
    const recording = {
      append: (now: Date) => {
        order.push('log');
        return log.append(now);
      },
    } as unknown as AnchorLogService;
    const anchoring = offlineAnchoring(m, tsa, { log: recording });
    const stamp = jest.spyOn(anchoring as never, 'stampTsa');
    stamp.mockImplementation((() => {
      order.push('tsa');
      return Promise.resolve('granted');
    }) as never);
    const report = await anchoring.run(NOW);
    expect(report.log).toEqual({
      state: 'appended',
      size: 1,
      appended: 1,
      signed: 1,
      signing: { state: 'signed' },
    });
    expect(order).toEqual(['log', 'tsa']);
    expect(m.logLeaves!.docs.map((d) => d.day)).toEqual(['2026-11-14']);
  });

  it('a failing log is reported, and the anchoring goes on', async () => {
    const m = anchorModels();
    addBlockVersion(m);
    const { log } = anchorLogFor(m, tsa);
    jest.spyOn(log, 'append').mockRejectedValue(new Error('db down'));
    const report = await offlineAnchoring(m, tsa, { log }).run(NOW);
    expect(report.log).toEqual({ state: 'failed', note: 'db down' });
    expect(report.tsa).toEqual([
      { anchorId: '2026-11-14', outcome: 'granted' },
    ]);
  });

  it('without the log, a run reports nothing about it', async () => {
    const m = anchorModels();
    addBlockVersion(m);
    const report = await offlineAnchoring(m, tsa).run(NOW);
    expect(report.log).toBeUndefined();
  });
});
