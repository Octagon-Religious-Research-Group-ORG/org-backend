import { Logger } from '@nestjs/common';
import {
  ReplicaSetCheckService,
  STANDALONE_WARNING,
} from './replica-set-check.service';

function build(answer: () => Promise<unknown>, connected = true) {
  const command = jest.fn(answer);
  const connection = connected
    ? { db: { admin: () => ({ command }) } }
    : { db: undefined };
  return {
    service: new ReplicaSetCheckService(connection as never),
    command,
  };
}

describe('ReplicaSetCheckService', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('is quiet on a replica set or a sharded cluster', async () => {
    const replica = build(() => Promise.resolve({ setName: 'rs0' }));
    await replica.service.onApplicationBootstrap();
    expect(replica.command).toHaveBeenCalledWith({ hello: 1 });
    expect(
      await build(() => Promise.resolve({ msg: 'isdbgrid' })).service.check(),
    ).toBe('replica-set');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once, plainly, about a standalone server, and never throws', async () => {
    expect(await build(() => Promise.resolve({})).service.check()).toBe(
      'standalone',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(STANDALONE_WARNING);
  });

  it('says it could not check when the database does not answer', async () => {
    expect(
      await build(() => Promise.reject(new Error('down'))).service.check(),
    ).toBe('unknown');
    // Not an Error on purpose: the log line must still read.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const odd = build(() => Promise.reject('odd'));
    expect(await odd.service.check()).toBe('unknown');
    expect(await build(() => Promise.resolve(), false).service.check()).toBe(
      'unknown',
    );
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String((warn.mock.calls[0] as unknown[])[0])).toMatch(
      /Could not check.*down/,
    );
  });
});
