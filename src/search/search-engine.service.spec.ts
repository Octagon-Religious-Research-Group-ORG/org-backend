/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import {
  ENGINE_RECHECK_MS,
  ensureAtlasIndex,
  isMissingTextIndex,
  readAtlasIndexState,
  SearchEngineService,
} from './search-engine.service';
import { ATLAS_SEARCH_INDEX_NAME } from './search-pipeline';

function collection(listed: unknown[] | Error, create?: Error) {
  return {
    listSearchIndexes: jest.fn(() => ({
      toArray: () =>
        listed instanceof Error
          ? Promise.reject(listed)
          : Promise.resolve(listed),
    })),
    createSearchIndex: jest.fn(() =>
      create
        ? Promise.reject(create)
        : Promise.resolve(ATLAS_SEARCH_INDEX_NAME),
    ),
  };
}

const ready = [{ name: ATLAS_SEARCH_INDEX_NAME, queryable: true }];

function service(listed: unknown[] | Error, manage = 'check', create?: Error) {
  const coll = collection(listed, create);
  const engine = new SearchEngineService(
    { collection: coll } as never,
    { get: (_key: string, fallback: string) => manage ?? fallback } as never,
  );
  const warn = jest
    .spyOn((engine as any).logger, 'warn')
    .mockImplementation(() => undefined);
  return { engine, coll, warn };
}

describe('Atlas Search index helpers', () => {
  it('reads ready, building, missing and unsupported', async () => {
    expect(await readAtlasIndexState(collection(ready))).toEqual({
      state: 'ready',
    });
    expect(
      await readAtlasIndexState(
        collection([{ name: ATLAS_SEARCH_INDEX_NAME, queryable: false }]),
      ),
    ).toEqual({ state: 'building' });
    expect(await readAtlasIndexState(collection([{ name: 'other' }]))).toEqual({
      state: 'missing',
    });
    expect(await readAtlasIndexState(collection(new Error('no')))).toEqual({
      state: 'unsupported',
      reason: 'no',
    });
    expect(await readAtlasIndexState(collection('plain' as never))).toEqual({
      state: 'unsupported',
      reason: expect.any(String),
    });
  });

  it('creates a missing index only when asked, and reports a refusal', async () => {
    const missing = collection([]);
    expect(await ensureAtlasIndex(missing, true)).toEqual({
      outcome: 'missing',
    });
    expect(missing.createSearchIndex).not.toHaveBeenCalled();
    expect(await ensureAtlasIndex(missing, false)).toEqual({
      outcome: 'created',
    });
    expect(
      await ensureAtlasIndex(collection([], new Error('tier')), false),
    ).toEqual({ outcome: 'unsupported', reason: 'tier' });
    expect(await ensureAtlasIndex(collection(ready), false)).toEqual({
      outcome: 'ready',
    });
  });

  it('recognises a missing text index', () => {
    expect(isMissingTextIndex({ code: 27 })).toBe(true);
    expect(isMissingTextIndex(new Error('text index required for $text'))).toBe(
      true,
    );
    expect(isMissingTextIndex(new Error('other'))).toBe(false);
    expect(isMissingTextIndex(undefined)).toBe(false);
  });
});

describe('SearchEngineService', () => {
  it('prefers Atlas when ready, rechecking after a while', async () => {
    const { engine, coll } = service(ready);
    expect(await engine.engines(0)).toEqual(['atlas', 'text', 'regex']);
    expect(await engine.engines(1)).toEqual(['atlas', 'text', 'regex']);
    expect(coll.listSearchIndexes).toHaveBeenCalledTimes(1);
    engine.atlasFailed(new Error('boom'), 2);
    expect(await engine.engines(3)).toEqual(['text', 'regex']);
    expect(await engine.engines(2 + ENGINE_RECHECK_MS)).toEqual([
      'atlas',
      'text',
      'regex',
    ]);
  });

  it('falls back and logs each state once', async () => {
    const { engine, warn } = service(new Error('not atlas'));
    expect(await engine.engines(0)).toEqual(['text', 'regex']);
    expect(await engine.engines(ENGINE_RECHECK_MS)).toEqual(['text', 'regex']);
    expect(warn).toHaveBeenCalledTimes(1);
    engine.textIndexMissing(0);
    expect(await engine.engines(1)).toEqual(['regex']);
    const missing = service([]);
    await missing.engine.engines(0);
    expect(missing.warn).toHaveBeenCalledWith(
      expect.stringContaining('is missing;'),
    );
  });

  it('keeps its log memory bounded', () => {
    const { engine, warn } = service([]);
    for (let n = 0; n < 101; n += 1) engine.atlasFailed(`error ${n}`);
    engine.atlasFailed('error 0');
    expect(warn).toHaveBeenCalledTimes(102);
  });

  it('creates the index at start-up only with MANAGE_INDEXES=create', async () => {
    const check = service([]);
    await check.engine.onApplicationBootstrap();
    expect(check.coll.createSearchIndex).not.toHaveBeenCalled();
    expect(check.warn).toHaveBeenCalledWith(
      expect.stringContaining('(check): missing.'),
    );
    const create = service([], 'create');
    await create.engine.onApplicationBootstrap();
    expect(create.coll.createSearchIndex).toHaveBeenCalled();
    const refused = service([], 'create', new Error('M0'));
    await refused.engine.onApplicationBootstrap();
    expect(refused.warn).toHaveBeenCalledWith(
      expect.stringContaining('unsupported (M0)'),
    );
  });
});

describe('SearchEngineService clock', () => {
  it('uses the current time by default', async () => {
    const { engine } = service([]);
    engine.textIndexMissing();
    engine.atlasFailed(new Error('x'));
    expect(await engine.engines()).toEqual(['regex']);
  });
});
