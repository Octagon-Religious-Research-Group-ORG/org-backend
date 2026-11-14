import type { PipelineStage, Types } from 'mongoose';
import type { SearchEntryKind } from './schemas/search-entry.schema';

/**
 * The aggregation that answers a search (Chunk 15). Only its FIRST stage
 * differs between engines; everything after it, above all the visibility
 * filter, is built here once and used by all of them, so the tests that run
 * on the `$text` fallback cover the exact filter Atlas Search runs behind.
 */

/** The one Atlas Search index this chunk adds (the free tier allows three). */
export const ATLAS_SEARCH_INDEX_NAME = 'search_entries';

/** The index definition, for `MANAGE_INDEXES=create`, `db:indexes` and the README. */
export const ATLAS_SEARCH_INDEX_DEFINITION = {
  mappings: {
    dynamic: false,
    fields: { text: { type: 'string', analyzer: 'lucene.standard' } },
  },
};

export type SearchEngine = 'atlas' | 'text' | 'regex';

export const RESULTS_PER_PAGE = 10;
/** A reader can page this far; past it, refine the query. */
export const MAX_RESULT_PAGE = 50;

/**
 * What a reader may see in search, decided page by page by
 * `decideProfileAccess` (`MembersService.searchScope`), never re-derived here.
 */
export interface SearchScope {
  /** Pages whose name may be listed for this reader (the directory's rule). */
  listed: Types.ObjectId[];
  /** Pages this reader may read in full: their beliefs are searchable. */
  full: Types.ObjectId[];
}

export const SEARCH_TYPES = ['all', 'members', 'beliefs', 'pages'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

const KINDS_OF: Record<SearchType, SearchEntryKind[]> = {
  all: ['member', 'belief-title', 'belief-text', 'page'],
  members: ['member'],
  beliefs: ['belief-title', 'belief-text'],
  pages: ['page'],
};

/** The engine-specific first stages: find the matches and give each a score. */
export function engineStages(
  engine: SearchEngine,
  query: string,
  terms: string[],
): PipelineStage[] {
  if (engine === 'atlas') {
    return [
      {
        $search: {
          index: ATLAS_SEARCH_INDEX_NAME,
          text: { query, path: 'text' },
        },
      },
      { $set: { score: { $meta: 'searchScore' } } },
    ];
  }
  if (engine === 'text') {
    return [
      { $match: { $text: { $search: query } } },
      { $set: { score: { $meta: 'textScore' } } },
    ];
  }
  // Last resort when no text index exists: every word must appear. The
  // collection holds a small community's text, so a scan stays bounded.
  return [
    {
      $match: {
        $and: terms.map((term) => ({
          text: { $regex: escapeRegex(term), $options: 'i' },
        })),
      },
    },
    { $set: { score: 1 } },
  ];
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const first = (field: string) => ({ $arrayElemAt: [field, 0] });

/**
 * THE visibility filter, for every engine. An entry survives only if
 * - its page is in the reader's scope at the level its kind needs (a name
 *   needs `listed`, belief text and titles need `full`);
 * - it is exactly what the site shows NOW: the page's current name, a live
 *   tab's current title, the newest version of a live block of that tab,
 *   the published revision of a CMS page.
 *
 * Runs before grouping, counting and paging, so neither a later page nor the
 * total can reveal an entry the reader may not see.
 */
export function visibilityStages(
  scope: SearchScope,
  type: SearchType,
): PipelineStage[] {
  return [
    {
      $match: {
        kind: { $in: KINDS_OF[type] },
        $or: [
          { kind: 'member', profileId: { $in: scope.listed } },
          {
            kind: { $in: ['belief-title', 'belief-text'] },
            profileId: { $in: scope.full },
          },
          { kind: 'page' },
        ],
      },
    },
    {
      $lookup: {
        from: 'socialprofiles',
        localField: 'profileId',
        foreignField: '_id',
        pipeline: [{ $project: { _id: 0, slug: 1, displayName: 1 } }],
        as: 'profile',
      },
    },
    {
      $lookup: {
        from: 'belieftabs',
        localField: 'tabId',
        foreignField: 'tabId',
        pipeline: [
          { $match: { removedAt: { $exists: false } } },
          { $project: { _id: 0, title: 1, profileId: 1 } },
        ],
        as: 'tab',
      },
    },
    {
      $lookup: {
        from: 'profileblocks',
        localField: 'blockId',
        foreignField: 'blockId',
        pipeline: [
          {
            $match: {
              removedAt: { $exists: false },
              section: 'beliefs',
              kind: { $ne: 'image' },
            },
          },
          { $project: { _id: 0, tabId: 1, profileId: 1 } },
        ],
        as: 'block',
      },
    },
    {
      $lookup: {
        from: 'blockversions',
        localField: 'blockId',
        foreignField: 'blockId',
        pipeline: [
          { $sort: { seq: -1 } },
          { $limit: 1 },
          { $project: { _id: 0, seq: 1 } },
        ],
        as: 'head',
      },
    },
    {
      $lookup: {
        from: 'websitepages',
        localField: 'pageId',
        foreignField: 'pageId',
        pipeline: [
          {
            $project: {
              _id: 0,
              revision: '$published.revision',
              title: '$published.content.title',
            },
          },
        ],
        as: 'cms',
      },
    },
    {
      $match: {
        $expr: {
          $switch: {
            branches: [
              {
                case: { $eq: ['$kind', 'member'] },
                then: { $eq: [first('$profile.displayName'), '$text'] },
              },
              {
                case: { $eq: ['$kind', 'belief-title'] },
                then: {
                  $and: [
                    { $eq: [first('$tab.title'), '$text'] },
                    { $eq: [first('$tab.profileId'), '$profileId'] },
                    { $gt: [{ $size: '$profile' }, 0] },
                  ],
                },
              },
              {
                case: { $eq: ['$kind', 'belief-text'] },
                then: {
                  $and: [
                    { $eq: [first('$tab.profileId'), '$profileId'] },
                    { $eq: [first('$block.tabId'), '$tabId'] },
                    { $eq: [first('$block.profileId'), '$profileId'] },
                    { $eq: [first('$head.seq'), '$seq'] },
                    { $gt: [{ $size: '$profile' }, 0] },
                  ],
                },
              },
              {
                case: { $eq: ['$kind', 'page'] },
                then: { $eq: [first('$cms.revision'), '$revision'] },
              },
            ],
            default: false,
          },
        },
      },
    },
  ];
}

/** One raw row of a results page, before `search.service.ts` shapes it. */
export interface SearchRow {
  kind: SearchEntryKind;
  text: string;
  profileId?: Types.ObjectId;
  tabId?: string;
  pageId?: string;
  part?: string;
  slug?: string;
  displayName?: string;
  tabTitle?: string;
  pageTitle?: string;
}

/**
 * One result per member page, per belief and per CMS page (its best match),
 * then the total and one page of them. Only ever after
 * {@link visibilityStages}.
 */
export function groupAndPageStages(page: number): PipelineStage[] {
  return [
    { $sort: { score: -1, _id: 1 } },
    {
      $group: {
        _id: {
          $switch: {
            branches: [
              {
                case: { $eq: ['$kind', 'member'] },
                then: { $concat: ['m:', { $toString: '$profileId' }] },
              },
              {
                case: { $eq: ['$kind', 'page'] },
                then: { $concat: ['p:', '$pageId'] },
              },
            ],
            default: { $concat: ['t:', '$tabId'] },
          },
        },
        score: { $max: '$score' },
        best: {
          $first: {
            kind: '$kind',
            text: '$text',
            profileId: '$profileId',
            tabId: '$tabId',
            pageId: '$pageId',
            part: '$part',
            slug: first('$profile.slug'),
            displayName: first('$profile.displayName'),
            tabTitle: first('$tab.title'),
            pageTitle: first('$cms.title'),
          },
        },
      },
    },
    { $sort: { score: -1, _id: 1 } },
    {
      $facet: {
        total: [{ $count: 'n' }],
        rows: [
          { $skip: (page - 1) * RESULTS_PER_PAGE },
          { $limit: RESULTS_PER_PAGE },
          { $replaceWith: '$best' },
        ],
      },
    },
  ];
}
