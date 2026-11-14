import { MemberPurgeScheduler, PURGE_TICK_MS } from './member-purge.scheduler';

describe('MemberPurgeScheduler', () => {
  afterEach(() => jest.useRealTimers());

  it('runs at start and then every hour, without keeping the process alive', async () => {
    jest.useFakeTimers();
    const purge = { run: jest.fn(() => Promise.resolve({ state: 'busy' })) };
    const scheduler = new MemberPurgeScheduler(purge as never);
    scheduler.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    expect(purge.run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(PURGE_TICK_MS);
    expect(purge.run).toHaveBeenCalledTimes(2);
    scheduler.onModuleDestroy();
    jest.advanceTimersByTime(PURGE_TICK_MS);
    expect(purge.run).toHaveBeenCalledTimes(2);
  });

  it('runs one at a time and logs a failure instead of throwing', async () => {
    const order: string[] = [];
    let first = true;
    const purge = {
      run: jest.fn(() => {
        if (first) {
          first = false;
          order.push('a');
          return Promise.reject(new Error('down'));
        }
        order.push('b');
        return Promise.resolve({ state: 'busy' });
      }),
    };
    const scheduler = new MemberPurgeScheduler(purge as never);
    const error = jest.spyOn(scheduler['logger'], 'error').mockImplementation();
    const at = new Date('2031-01-01T00:00:00Z');
    const [a, b] = await Promise.all([scheduler.tick(at), scheduler.tick()]);
    expect(a).toBeUndefined();
    expect(b).toEqual({ state: 'busy' });
    expect(order).toEqual(['a', 'b']);
    expect(purge.run.mock.calls[0]).toEqual([at]);
    expect(error).toHaveBeenCalledWith('Five-year purge failed: down');
    purge.run.mockRejectedValueOnce('plain');
    await scheduler.tick();
    expect(error).toHaveBeenCalledWith('Five-year purge failed: plain');
  });

  it('stops nothing it never started', () => {
    expect(() =>
      new MemberPurgeScheduler({} as never).onModuleDestroy(),
    ).not.toThrow();
  });
});
