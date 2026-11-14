import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { MembersService } from '../members/members.service';
import { GUEST_VIEWER, type Viewer } from '../members/profile-access';
import { readSiteEnv, type SiteEnv } from '../config/site-env';
import {
  SearchEntry,
  type SearchEntryDocument,
} from './schemas/search-entry.schema';
import {
  SearchEngineService,
  isMissingTextIndex,
} from './search-engine.service';
import { SearchIndexerService } from './search-indexer.service';
import {
  engineStages,
  groupAndPageStages,
  phraseStages,
  RESULTS_PER_PAGE,
  type SearchEngine,
  type SearchRow,
  type SearchScope,
  type SearchType,
  visibilityStages,
} from './search-pipeline';
import { type Highlight, makeSnippet, queryTerms } from './search-text';

export const SEARCH_UNAVAILABLE = 'Search is unavailable right now.';

interface Snippet {
  snippet: string;
  highlights: Highlight[];
}

/**
 * One result. Nothing in it comes from a page the reader may not read:
 * a `member` result for a page they may only see listed carries its name and
 * nothing else, exactly like its directory card.
 */
export type SearchResult =
  | ({
      kind: 'member';
      slug: string;
      displayName: string;
      /** The reader sees only the name, as in the directory. */
      membersOnly: boolean;
    } & Snippet)
  | ({
      kind: 'belief';
      slug: string;
      displayName: string;
      tabId: string;
      title: string;
      /** Whether the match was in the belief's title or its text. */
      matched: 'title' | 'text';
    } & Snippet)
  | ({
      kind: 'page';
      pageId: string;
      title: string;
      /** The matched part: `title`, `subtitle`, `block:<id>`, `node:<id>`, `article:<id>`. */
      part: string;
    } & Snippet);

export interface SearchResponse {
  query: string;
  type: SearchType;
  page: number;
  pageSize: number;
  total: number;
  results: SearchResult[];
}

/** Searching names, beliefs and ORG pages (Chunk 15), as one reader may see them. */
@Injectable()
export class SearchService {
  constructor(
    @InjectModel(SearchEntry.name)
    private readonly entryModel: Model<SearchEntryDocument>,
    private readonly members: MembersService,
    private readonly engines: SearchEngineService,
    private readonly indexer: SearchIndexerService,
    config: ConfigService,
  ) {
    this.site = readSiteEnv(config);
  }

  private readonly site: SiteEnv;

  /**
   * @param query - already normalised (`normaliseQuery`) and checked for length
   * @throws ServiceUnavailableException when no engine can answer
   */
  async search(
    query: string,
    type: SearchType,
    page: number,
    viewer: Viewer,
  ): Promise<SearchResponse> {
    const terms = queryTerms(query);
    if (terms.length === 0) {
      return this.empty(query, type, page);
    }
    await this.indexer.ensureFresh();
    const [scope, engines] = await Promise.all([
      this.members.searchScope(viewer),
      this.engines.engines(),
    ]);
    const full = new Set(scope.full.map(String));
    const { total, rows } = await this.run(engines, terms.join(' '), terms, [
      ...visibilityStages(scope, type, this.site),
      ...groupAndPageStages(page),
    ]);
    return {
      query,
      type,
      page,
      pageSize: RESULTS_PER_PAGE,
      total,
      results: rows.map((row) => shape(row, terms, full)),
    };
  }

  /** Changes whenever the indexer writes: a cache of results can key on it. */
  indexGeneration(): number {
    return this.indexer.generation();
  }

  /** What a signed-out reader may find; read once and shared by several checks. */
  guestScope(): Promise<SearchScope> {
    return this.members.searchScope(GUEST_VIEWER);
  }

  /**
   * How many entries a signed-out reader may see that hold `phrase`, every
   * word of it, as whole words in this order (review H1a): the Suggested
   * Fragments' public-match check. Behind the same visibility filter as a
   * search, on the same folded copy every engine searches.
   *
   * @param phrase - folded words joined by single spaces (`foldWords`)
   * @param scope - a guest scope already read, to share it across checks
   */
  async publicPhraseCount(
    phrase: string,
    scope?: SearchScope,
  ): Promise<number> {
    const [result] = await this.entryModel
      .aggregate<{
        n: number;
      }>([
        ...phraseStages(phrase),
        ...visibilityStages(
          scope ?? (await this.guestScope()),
          'all',
          this.site,
        ),
        { $count: 'n' },
      ] as never[])
      .exec();
    return result?.n ?? 0;
  }

  empty(query: string, type: SearchType, page: number): SearchResponse {
    return {
      query,
      type,
      page,
      pageSize: RESULTS_PER_PAGE,
      total: 0,
      results: [],
    };
  }

  /** The same stages behind each engine in turn, until one answers. */
  private async run(
    engines: SearchEngine[],
    query: string,
    terms: string[],
    after: object[],
  ): Promise<{ total: number; rows: SearchRow[] }> {
    for (const engine of engines) {
      try {
        const [result] = await this.entryModel
          .aggregate<{
            total: Array<{ n: number }>;
            rows: SearchRow[];
          }>([...engineStages(engine, query, terms), ...(after as never[])])
          .exec();
        return { total: result?.total[0]?.n ?? 0, rows: result?.rows ?? [] };
      } catch (error) {
        if (engine === 'atlas') {
          this.engines.atlasFailed(error);
        } else if (engine === 'text' && isMissingTextIndex(error)) {
          this.engines.textIndexMissing();
        } else {
          throw new ServiceUnavailableException(SEARCH_UNAVAILABLE);
        }
      }
    }
    throw new ServiceUnavailableException(SEARCH_UNAVAILABLE);
  }
}

function shape(
  row: SearchRow,
  terms: string[],
  full: Set<string>,
): SearchResult {
  const snippet = makeSnippet(row.text, terms);
  if (row.kind === 'member') {
    return {
      kind: 'member',
      slug: String(row.slug),
      displayName: String(row.displayName),
      membersOnly: !full.has(String(row.profileId)),
      ...snippet,
    };
  }
  if (row.kind === 'page') {
    return {
      kind: 'page',
      pageId: String(row.pageId),
      title: String(row.pageTitle),
      part: String(row.part),
      ...snippet,
    };
  }
  return {
    kind: 'belief',
    slug: String(row.slug),
    displayName: String(row.displayName),
    tabId: String(row.tabId),
    title: String(row.tabTitle),
    matched: row.kind === 'belief-title' ? 'title' : 'text',
    ...snippet,
  };
}
