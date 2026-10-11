import {
  EXIT_CODES,
  formatIndexOutcome,
  type IndexedModel,
  reconcileIndexes,
} from './index-setup';

function fakeModel(
  modelName: string,
  diffs: Array<{ toCreate: unknown[]; toDrop: unknown[] }>,
): IndexedModel & { createIndexes: jest.Mock; diffIndexes: jest.Mock } {
  const diffIndexes = jest.fn();
  for (const diff of diffs) diffIndexes.mockResolvedValueOnce(diff);
  return {
    modelName,
    diffIndexes,
    createIndexes: jest.fn().mockResolvedValue(undefined),
  };
}

describe('reconcileIndexes', () => {
  it('creates missing indexes and confirms them by re-reading', async () => {
    const model = fakeModel('BlockVersion', [
      { toCreate: [{ blockId: 1, seq: 1 }], toDrop: [] },
      { toCreate: [], toDrop: [] },
    ]);

    const outcome = await reconcileIndexes([model], { dryRun: false });

    expect(model.createIndexes).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      status: 'ok',
      reports: [
        { model: 'BlockVersion', missing: 1, extras: [], stillMissing: 0 },
      ],
    });
    expect(formatIndexOutcome(outcome, false)).toEqual([
      'BlockVersion: 1 created, 0 still missing',
    ]);
  });

  it('changes nothing in a dry run and reports what is missing', async () => {
    const model = fakeModel('ProfileBlock', [
      { toCreate: [{ blockId: 1 }], toDrop: [] },
    ]);

    const outcome = await reconcileIndexes([model], { dryRun: true });

    expect(model.createIndexes).not.toHaveBeenCalled();
    expect(model.diffIndexes).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('attention');
    expect(formatIndexOutcome(outcome, true)).toEqual([
      'ProfileBlock: 1 missing',
    ]);
  });

  it('skips creation when nothing is missing', async () => {
    const model = fakeModel('SocialProfile', [
      { toCreate: [], toDrop: [] },
      { toCreate: [], toDrop: [] },
    ]);

    await expect(reconcileIndexes([model], { dryRun: false })).resolves.toEqual(
      {
        status: 'ok',
        reports: [
          { model: 'SocialProfile', missing: 0, extras: [], stillMissing: 0 },
        ],
      },
    );
    expect(model.createIndexes).not.toHaveBeenCalled();
  });

  it('reports an undeclared index and never drops it', async () => {
    const model = fakeModel('SocialProfile', [
      { toCreate: [], toDrop: ['email_1', { legacy: 1 }] },
      { toCreate: [], toDrop: ['email_1', { legacy: 1 }] },
    ]);

    const outcome = await reconcileIndexes([model], { dryRun: false });

    expect(outcome.status).toBe('attention');
    expect(formatIndexOutcome(outcome, false)).toEqual([
      'SocialProfile: 0 created, 0 still missing; 2 not declared (left in place): email_1, {"legacy":1}',
    ]);
  });

  it('flags an index that is still missing after creation', async () => {
    const model = fakeModel('BlockVersion', [
      { toCreate: [{ seq: 1 }], toDrop: [] },
      { toCreate: [{ seq: 1 }], toDrop: [] },
    ]);

    const outcome = await reconcileIndexes([model], { dryRun: false });

    expect(outcome.status).toBe('attention');
  });

  it.each([
    ['an Error', new Error('connection refused'), 'connection refused'],
    ['a non-Error value', 'boom', 'boom'],
  ])(
    'says it cannot measure when the database throws %s',
    async (_label, thrown, message) => {
      const model = fakeModel('BlockVersion', []);
      model.diffIndexes.mockRejectedValueOnce(thrown);

      const outcome = await reconcileIndexes([model], { dryRun: false });

      expect(outcome).toEqual({
        status: 'cannot-measure',
        model: 'BlockVersion',
        error: message,
      });
      expect(formatIndexOutcome(outcome, false)).toEqual([
        `CANNOT MEASURE BlockVersion: ${message}`,
      ]);
    },
  );

  it('maps outcomes to the three exit codes', () => {
    expect(EXIT_CODES).toEqual({ ok: 0, attention: 1, 'cannot-measure': 3 });
  });
});
