import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  inTransaction,
  isTransactionUnsupported,
  NEEDS_REPLICA_SET,
} from './transactions';
import { fakeConnection } from './transactions.mocks-spec';

describe('inTransaction', () => {
  it('returns what the work returned, and ends the session', async () => {
    const { connection, session } = fakeConnection();
    await expect(
      inTransaction(connection as never, (s) => {
        expect(s).toBe(session);
        return Promise.resolve(42);
      }),
    ).resolves.toBe(42);
    expect(session.committed).toBe(1);
    expect(session.ended).toBe(1);
  });

  it('passes a failure on, and still ends the session', async () => {
    const { connection, session } = fakeConnection();
    await expect(
      inTransaction(connection as never, () =>
        Promise.reject(new Error('synthetic')),
      ),
    ).rejects.toThrow('synthetic');
    expect(session.aborted).toBe(1);
    expect(session.ended).toBe(1);
  });

  it('says plainly when the database cannot run transactions', async () => {
    const errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    for (const failure of [
      Object.assign(new Error('IllegalOperation'), { code: 20 }),
      {
        message:
          'Transaction numbers are only allowed on a replica set member or mongos',
      },
    ]) {
      const { connection, session } = fakeConnection(failure);
      await expect(
        inTransaction(connection as never, () => Promise.resolve()),
      ).rejects.toThrow(new ServiceUnavailableException(NEEDS_REPLICA_SET));
      expect(session.ended).toBe(1);
    }
    expect(errorLog).toHaveBeenCalledTimes(2);
    errorLog.mockRestore();
  });
});

describe('isTransactionUnsupported', () => {
  it.each([
    [{ code: 20 }, true],
    [
      { message: 'This MongoDB deployment does not support retryable writes' },
      true,
    ],
    [{ message: 'replica set member or mongos' }, true],
    [{ code: 11000 }, false],
    [{ message: 42 }, false],
    [null, false],
    ['text', false],
  ])('%o → %s', (error, expected) => {
    expect(isTransactionUnsupported(error)).toBe(expected);
  });
});
