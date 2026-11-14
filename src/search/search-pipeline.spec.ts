/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Types } from 'mongoose';
import {
  ATLAS_SEARCH_INDEX_NAME,
  engineStages,
  groupAndPageStages,
  phraseStages,
  RESULTS_PER_PAGE,
  visibilityStages,
} from './search-pipeline';

describe('search pipeline', () => {
  it('starts each engine with its own stage and a score', () => {
    expect(engineStages('atlas', 'lamp', ['lamp'])).toEqual([
      {
        $search: {
          index: ATLAS_SEARCH_INDEX_NAME,
          text: { query: 'lamp', path: 'folded' },
        },
      },
      { $set: { score: { $meta: 'searchScore' } } },
    ]);
    expect(engineStages('text', 'lamp', ['lamp'])[0]).toEqual({
      $match: { $text: { $search: 'lamp' } },
    });
    expect(engineStages('regex', 'a.b c', ['a.b', 'c'])[0]).toEqual({
      $match: {
        $and: [{ folded: { $regex: 'a\\.b' } }, { folded: { $regex: 'c' } }],
      },
    });
  });

  it('scopes names to listed pages and beliefs to fully readable ones', () => {
    const listed = [new Types.ObjectId()];
    const full = [new Types.ObjectId()];
    const [first] = visibilityStages(
      { listed, full },
      'beliefs',
      'production',
    ) as Array<{
      $match: Record<string, unknown>;
    }>;
    expect(first.$match).toEqual({
      kind: { $in: ['belief-title', 'belief-text'] },
      $or: [
        { kind: 'member', profileId: { $in: listed } },
        {
          kind: { $in: ['belief-title', 'belief-text'] },
          profileId: { $in: full },
        },
        { kind: 'page' },
      ],
    });
  });

  it('matches a phrase as whole words', () => {
    expect(phraseStages('lamp light')[0]).toEqual({
      $match: {
        kind: { $in: ['belief-text', 'page'] },
        folded: { $regex: ' lamp light ' },
      },
    });
  });

  it('pages after grouping', () => {
    const stages = groupAndPageStages(3) as Array<Record<string, any>>;
    expect(stages.at(-1)?.$facet.rows[0]).toEqual({
      $skip: 2 * RESULTS_PER_PAGE,
    });
  });
});
