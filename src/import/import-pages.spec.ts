import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { reconcileIndexes } from '../db/index-setup';
import { main } from './import-pages';
import { MongoImportStore } from './pages/mongo-store';

jest.mock('./pages/mongo-store');
jest.mock('../db/index-setup');

describe('import:pages database guard (the CLI itself)', () => {
  const originalArgv = process.argv;
  const originalUri = process.env.MONGODB_URI;
  let dir: string;

  function connectTo(databaseName: string) {
    const close = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(mongoose, 'createConnection').mockReturnValue({
      asPromise: () =>
        Promise.resolve({ db: { databaseName }, host: 'fake-host', close }),
    } as never);
    return close;
  }

  function run(...flags: string[]) {
    process.argv = ['node', 'import-pages', '--dir', dir, ...flags];
    return main();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'import-pages-'));
    writeFileSync(join(dir, 'manifest.json'), '[]');
    process.env.MONGODB_URI = 'mongodb://fake-host/never-contacted';
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (reconcileIndexes as jest.Mock).mockResolvedValue({ status: 'ok' });
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env.MONGODB_URI = originalUri;
    jest.restoreAllMocks();
    jest.clearAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(['test', 'org-latest-production'])(
    'refuses %p (production is named test) and opens no store',
    async (database) => {
      const close = connectTo(database);

      await expect(run('--confirm', database, '--replace')).resolves.toBe(2);

      expect(MongoImportStore).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
    },
  );

  it('refuses the test database without a matching --confirm', async () => {
    connectTo('org-testing');

    await expect(run('--confirm', 'test')).resolves.toBe(2);

    expect(MongoImportStore).not.toHaveBeenCalled();
  });

  it('proceeds on the test database when confirmed', async () => {
    connectTo('org-testing');

    await expect(run('--confirm', 'org-testing')).resolves.toBe(0);

    expect(MongoImportStore).toHaveBeenCalledTimes(1);
  });
});
