import { Logger } from '@nestjs/common';
import { AnchorScheduler } from './anchor-scheduler.service';

// Review round 1, L1: the publication job wakes the sleeping server, then
// waits for the run every start makes (it builds the day and signs it)
// before it fetches the checkpoint. So the server says when that run is done.
describe('L1: the start-up run says when it is done', () => {
  afterEach(() => jest.restoreAllMocks());

  it('L1: pending until the start-up run finishes, then done with its time', async () => {
    jest.spyOn(global, 'setInterval').mockReturnValue({ unref() {} } as never);
    let finish!: () => void;
    const anchoring = {
      enabled: true,
      run: jest.fn(
        () =>
          new Promise((resolve) => {
            finish = () =>
              resolve({ build: { state: 'built' }, tsa: [], ots: [] });
          }),
      ),
    };
    const scheduler = new AnchorScheduler(anchoring as never);
    scheduler.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));
    // The run has started and not finished.
    expect(scheduler.startup()).toEqual({ state: 'running' });
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect(scheduler.startup()).toMatchObject({
      state: 'done',
      finishedAt: expect.any(String) as unknown,
    });
    scheduler.onModuleDestroy();
  });

  it('a start-up run that failed is done too (the job then fetches what there is)', async () => {
    jest.spyOn(global, 'setInterval').mockReturnValue({ unref() {} } as never);
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const anchoring = {
      enabled: true,
      run: jest.fn().mockRejectedValue(new Error('down')),
    };
    const scheduler = new AnchorScheduler(anchoring as never);
    scheduler.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));
    expect(scheduler.startup()).toMatchObject({ state: 'done' });
  });

  it('switched off: off, at once; before start-up: not started', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const scheduler = new AnchorScheduler({ enabled: false } as never);
    expect(scheduler.startup()).toEqual({ state: 'not-started' });
    scheduler.onApplicationBootstrap();
    expect(scheduler.startup()).toEqual({ state: 'off' });
  });
});
