import { Logger } from '@nestjs/common';
import { ANCHOR_TICK_MS, AnchorScheduler } from './anchor-scheduler.service';

describe('AnchorScheduler', () => {
  const report = { build: { state: 'nothing-new' }, tsa: [], ots: [] };
  let anchoring: { enabled: boolean; run: jest.Mock };
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    anchoring = { enabled: true, run: jest.fn().mockResolvedValue(report) };
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('when switched off, says so and starts no timer', () => {
    anchoring.enabled = false;
    const interval = jest.spyOn(global, 'setInterval');
    const scheduler = new AnchorScheduler(anchoring as never);
    scheduler.onApplicationBootstrap();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ANCHORING_ENABLED=false'),
    );
    expect(interval).not.toHaveBeenCalled();
    expect(anchoring.run).not.toHaveBeenCalled();
    scheduler.onModuleDestroy();
  });

  it('catches up at start (a sleeping server wakes late), then hourly, never holding the process', async () => {
    const unref = jest.fn();
    const interval = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue({ unref } as never);
    const clear = jest.spyOn(global, 'clearInterval').mockImplementation();
    const scheduler = new AnchorScheduler(anchoring as never);
    scheduler.onApplicationBootstrap();
    expect(interval).toHaveBeenCalledWith(expect.any(Function), ANCHOR_TICK_MS);
    expect(ANCHOR_TICK_MS).toBe(3_600_000);
    expect(unref).toHaveBeenCalled();
    await scheduler.tick();
    expect(anchoring.run).toHaveBeenCalledWith(expect.any(Date), false);
    // The timer's callback runs a tick too.
    interval.mock.calls[0][0]();
    await scheduler.tick();
    expect(anchoring.run).toHaveBeenCalledTimes(4);
    scheduler.onModuleDestroy();
    expect(clear).toHaveBeenCalled();
  });

  it('a failed tick is logged and the next one still runs', async () => {
    anchoring.run
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce('odd')
      .mockResolvedValue(report);
    const scheduler = new AnchorScheduler(anchoring as never);
    expect(await scheduler.tick(new Date())).toBeUndefined();
    expect(await scheduler.tick()).toBeUndefined();
    expect(await scheduler.tick()).toBe(report);
    expect(error).toHaveBeenCalledWith('Anchoring run failed: db down');
    expect(error).toHaveBeenCalledWith('Anchoring run failed: odd');
  });

  it('runs never overlap in one process; "run now" forces the day and reports its failure', async () => {
    const order: string[] = [];
    let release!: () => void;
    anchoring.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          order.push('first starts');
          release = () => {
            order.push('first ends');
            resolve(report);
          };
        }),
    );
    anchoring.run.mockImplementationOnce((_now: Date, force: boolean) => {
      order.push(`second starts (force ${force})`);
      return Promise.reject(new Error('busy'));
    });
    const scheduler = new AnchorScheduler(anchoring as never);
    const first = scheduler.tick();
    const second = scheduler.runNow(new Date());
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await first;
    await expect(second).rejects.toThrow('busy');
    expect(order).toEqual([
      'first starts',
      'first ends',
      'second starts (force true)',
    ]);
    await expect(scheduler.runNow()).resolves.toBe(report);
  });
});
