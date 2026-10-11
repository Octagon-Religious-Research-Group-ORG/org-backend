import { Logger } from '@nestjs/common';
import { ManagedIndexesService } from './managed-indexes.service';

function model(name: string, toCreate: unknown[] = [], toDrop: unknown[] = []) {
  return {
    modelName: name,
    diffIndexes: jest.fn().mockResolvedValue({ toCreate, toDrop }),
    createIndexes: jest.fn().mockResolvedValue(undefined),
  };
}

function build(mode: string | undefined, missing: unknown[] = []) {
  const config = {
    get: jest.fn((_key: string, fallback: string) => mode ?? fallback),
  };
  const models = [
    model('SocialProfile'),
    model('ProfileBlock'),
    model('BlockVersion', missing),
    model('ModerationLogEntry'),
  ];
  const service = new ManagedIndexesService(
    config as never,
    models[0] as never,
    models[1] as never,
    models[2] as never,
    models[3] as never,
  );
  return { service, models };
}

describe('ManagedIndexesService', () => {
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('only checks by default and logs success', async () => {
    const { service, models } = build(undefined);

    await service.onApplicationBootstrap();

    for (const m of models) expect(m.createIndexes).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Managed indexes OK (check).');
    expect(error).not.toHaveBeenCalled();
  });

  it('logs missing indexes as an error in check mode without creating them', async () => {
    const { service, models } = build('check', [{ blockId: 1, seq: 1 }]);

    await service.onApplicationBootstrap();

    expect(models[2].createIndexes).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      'Managed indexes (check): BlockVersion: 1 missing',
    );
  });

  it('creates missing indexes in create mode', async () => {
    const { service, models } = build('create', [{ blockId: 1, seq: 1 }]);

    await service.onApplicationBootstrap();

    expect(models[2].createIndexes).toHaveBeenCalledTimes(1);
  });
});
