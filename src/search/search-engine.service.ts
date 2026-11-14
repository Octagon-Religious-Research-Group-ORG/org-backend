import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  SearchEntry,
  type SearchEntryDocument,
} from './schemas/search-entry.schema';
import {
  ATLAS_SEARCH_INDEX_DEFINITION,
  ATLAS_SEARCH_INDEX_NAME,
  type SearchEngine,
} from './search-pipeline';

/** How long an answer about the indexes is trusted before asking again. */
export const ENGINE_RECHECK_MS = 5 * 60_000;
/** Distinct log lines kept, so a stream of different errors stays bounded. */
const MAX_LOGGED_LINES = 100;

/** MongoDB's code for "text index required for $text query". */
const INDEX_NOT_FOUND = 27;

export function isMissingTextIndex(error: unknown): boolean {
  const { code, message } = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
  };
  return (
    code === INDEX_NOT_FOUND ||
    (typeof message === 'string' && /text index required/i.test(message))
  );
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export type AtlasIndexState = 'ready' | 'building' | 'missing' | 'unsupported';
export type AtlasIndexOutcome = AtlasIndexState | 'created';

/** The part of a driver collection the Atlas index helpers need. */
export interface SearchIndexCollection {
  listSearchIndexes(name: string): { toArray(): Promise<unknown[]> };
  createSearchIndex(description: {
    name: string;
    definition: object;
  }): Promise<string>;
}

/**
 * The Atlas Search index's state. `unsupported` when the server cannot list
 * search indexes at all (a local mongod), with the reason.
 */
export async function readAtlasIndexState(
  collection: SearchIndexCollection,
): Promise<{ state: AtlasIndexState; reason?: string }> {
  try {
    const indexes = (await collection
      .listSearchIndexes(ATLAS_SEARCH_INDEX_NAME)
      .toArray()) as Array<{ name?: string; queryable?: boolean }>;
    const index = indexes.find((row) => row.name === ATLAS_SEARCH_INDEX_NAME);
    if (!index) return { state: 'missing' };
    return { state: index.queryable === true ? 'ready' : 'building' };
  } catch (error) {
    return { state: 'unsupported', reason: describe(error) };
  }
}

/** MongoDB's code for "collection already exists". */
const NAMESPACE_EXISTS = 48;

/**
 * Creates the Atlas Search index when it is missing. Never drops or changes
 * one. The collection is created first when it does not exist yet: it has
 * `autoCreate: false`, so a fresh database has none, and a search index
 * needs one (review L3). Where the server refuses (a local mongod, a tier
 * without the command) the outcome is `unsupported` with the reason, and
 * search keeps using `$text`.
 *
 * @param createCollection - creates the collection; "already exists" is fine
 */
export async function ensureAtlasIndex(
  collection: SearchIndexCollection,
  dryRun: boolean,
  createCollection: () => Promise<unknown>,
): Promise<{ outcome: AtlasIndexOutcome; reason?: string }> {
  const { state, reason } = await readAtlasIndexState(collection);
  if (state !== 'missing' || dryRun) return { outcome: state, reason };
  try {
    await createCollection().catch((error: { code?: unknown }) => {
      if (error?.code !== NAMESPACE_EXISTS) throw error;
    });
    await collection.createSearchIndex({
      name: ATLAS_SEARCH_INDEX_NAME,
      definition: ATLAS_SEARCH_INDEX_DEFINITION,
    });
    return { outcome: 'created' };
  } catch (error) {
    return { outcome: 'unsupported', reason: describe(error) };
  }
}

/**
 * Which engine search can use now (Chunk 15): Atlas Search where its index
 * exists and is queryable, else `$text`, else a bounded regex. A missing or
 * still-building index is NOT an error for the reader: it is logged once and
 * search carries on with the next engine.
 *
 * With `MANAGE_INDEXES=create` it creates the Atlas Search index if the
 * server allows it, at start-up and again at each periodic check while the
 * index is missing (review L3); with `check` it only reports.
 */
@Injectable()
export class SearchEngineService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SearchEngineService.name);
  private readonly manage: string;
  private atlasCheckedAt = Number.NEGATIVE_INFINITY;
  private atlasReady = false;
  private textMissingUntil = 0;
  private readonly logged = new Set<string>();

  constructor(
    @InjectModel(SearchEntry.name)
    private readonly entryModel: Model<SearchEntryDocument>,
    config: ConfigService,
  ) {
    this.manage = config.get<string>('MANAGE_INDEXES', 'check');
  }

  async onApplicationBootstrap() {
    const dryRun = this.manage !== 'create';
    const { outcome, reason } = await this.ensure(dryRun);
    this.note(
      `Atlas Search index ${ATLAS_SEARCH_INDEX_NAME} (${this.manage}): ${outcome}${reason ? ` (${reason})` : ''}.`,
    );
  }

  /** The engines to try, best first. */
  async engines(now = Date.now()): Promise<SearchEngine[]> {
    if (now - this.atlasCheckedAt >= ENGINE_RECHECK_MS) {
      this.atlasCheckedAt = now;
      const { state, reason } =
        this.manage === 'create'
          ? await this.ensure(false).then(({ outcome, reason }) => ({
              state: outcome,
              reason,
            }))
          : await readAtlasIndexState(this.collection());
      this.atlasReady = state === 'ready';
      if (!this.atlasReady) {
        this.note(
          `Atlas Search index is ${state}${reason ? ` (${reason})` : ''}; search uses the fallback.`,
        );
      }
    }
    const fallback: SearchEngine[] =
      now < this.textMissingUntil ? ['regex'] : ['text', 'regex'];
    return this.atlasReady ? ['atlas', ...fallback] : fallback;
  }

  /** `$search` failed although its index looked ready: use the fallback for a while. */
  atlasFailed(error: unknown, now = Date.now()) {
    this.atlasReady = false;
    this.atlasCheckedAt = now;
    this.note(`Atlas Search failed, using the fallback: ${describe(error)}`);
  }

  /** The `$text` index is missing: use the regex until it is checked again. */
  textIndexMissing(now = Date.now()) {
    this.textMissingUntil = now + ENGINE_RECHECK_MS;
    this.note(
      'The $text fallback index is missing (run db:indexes); search uses a regex.',
    );
  }

  private ensure(dryRun: boolean) {
    return ensureAtlasIndex(this.collection(), dryRun, () =>
      this.entryModel.createCollection(),
    );
  }

  private collection(): SearchIndexCollection {
    return this.entryModel.collection;
  }

  /** Logs each state once per process, not on every search. */
  private note(line: string) {
    if (this.logged.has(line)) return;
    if (this.logged.size >= MAX_LOGGED_LINES) this.logged.clear();
    this.logged.add(line);
    this.logger.warn(line);
  }
}
