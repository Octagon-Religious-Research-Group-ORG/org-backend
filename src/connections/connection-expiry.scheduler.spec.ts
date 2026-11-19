import { Logger } from '@nestjs/common';
import {
  ConnectionExpiryScheduler,
  EXPIRY_TICK_MS,
} from './connection-expiry.scheduler';

describe('ConnectionExpiryScheduler', () => {
  afterEach(() => jest.useRealTimers());

  it('sweeps at start and hourly, and stops with the module', async () => {
    jest.useFakeTimers();
    const records = { expireStale: jest.fn(() => Promise.resolve()) };
    const scheduler = new ConnectionExpiryScheduler(records as never);
    scheduler.onApplicationBootstrap();
    await Promise.resolve();
    expect(records.expireStale).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(EXPIRY_TICK_MS);
    expect(records.expireStale).toHaveBeenCalledTimes(2);
    scheduler.onModuleDestroy();
    jest.advanceTimersByTime(EXPIRY_TICK_MS);
    expect(records.expireStale).toHaveBeenCalledTimes(2);
    new ConnectionExpiryScheduler(records as never).onModuleDestroy();
  });

  it('logs a failed sweep instead of throwing', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    for (const failure of [new Error('down'), 'plain']) {
      const records = {
        // A driver can reject with anything, not only an Error.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        expireStale: jest.fn(() => Promise.reject(failure)),
      };
      await expect(
        new ConnectionExpiryScheduler(records as never).tick(),
      ).resolves.toBeUndefined();
    }
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
