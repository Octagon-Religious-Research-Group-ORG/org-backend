import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ModerationLogService } from '../moderation/moderation-log.service';
import {
  SearchFragmentHide,
  type SearchFragmentHideDocument,
} from './schemas/search-fragment-hide.schema';
import {
  SearchFragmentPair,
  type SearchFragmentPairDocument,
} from './schemas/search-fragment-pair.schema';
import {
  SearchTermWindow,
  type SearchTermWindowDocument,
} from './schemas/search-term-window.schema';
import { FragmentKeys, fragmentSecret } from './fragment-keys';
import type { SearchScope } from './search-pipeline';
import { SearchService } from './search.service';
import { foldWords, isFragmentShaped, normaliseQuery } from './search-text';

/** Defaults for the two settings (`SEARCH_FRAGMENT_*`). */
export const FRAGMENT_DEFAULTS = { minSearchers: 5, windowDays: 30 };
/** Fragments the Perforated Index shows at most. */
export const MAX_FRAGMENTS = 8;
/** Candidates read per listing, most-searched first. */
const MAX_CANDIDATES = 50;
/**
 * How long the list of CANDIDATES (counts and hidden terms) is kept. A
 * count or a hide drops it at once.
 */
export const CANDIDATES_CACHE_MS = 10 * 60_000;
/**
 * How long the full eligibility pass over the candidates is reused while
 * nothing it depends on changed: the candidates, what a guest may see (the
 * guest scope, read on every request) and the search index
 * (`indexGeneration`). Even then, every term it showed is checked again on
 * every request through the same live visibility filter as a search, so a
 * term whose page went private, or whose belief was removed, edited or
 * moderated, is never served, whether or not the indexer has run
 * (round-3 review). Those are at most {@link MAX_FRAGMENTS} small queries.
 */
export const ELIGIBLE_CACHE_MS = 60_000;
/**
 * Different terms one searcher can add to the counts per window, so one
 * visitor cannot crowd the store or the candidates (round-2 review L1).
 * Held in memory only (a restart resets it); the rate limit of 30 searches
 * a minute bounds it further.
 */
export const MAX_TERMS_PER_VISITOR = 50;
/**
 * Searchers the per-searcher limit remembers per window, at most. When it
 * is full the searcher seen LONGEST AGO is forgotten (round-3 review L2), so
 * a new searcher is always counted: nobody is frozen out. A forgotten
 * searcher may add up to {@link MAX_TERMS_PER_VISITOR} terms again, which
 * takes this many other new searchers arriving after them first.
 */
const MAX_TRACKED_VISITORS = 100_000;
const DAY_MS = 86_400_000;

export const FRAGMENT_NOT_SHAPED =
  'That is not a term a fragment can be: 3–40 letters, digits, spaces, hyphens or apostrophes, at most four words.';
export const DEFAULT_HIDE_REASON = 'No reason given.';
export const FRAGMENTS_OFF =
  'Suggested Fragments are off: CLERK_SECRET_KEY is empty, so no key can be derived.';

/** Which fixed window of `days` days `at` falls in (days counted from 1970-01-01 UTC). */
export function windowIndex(at: Date, days: number): number {
  return Math.floor(Math.floor(at.getTime() / DAY_MS) / days);
}

/**
 * A term in the one form it is counted, shown and hidden under, or
 * undefined when what was typed is not fragment-shaped (checked BEFORE
 * folding, so an address or a code is refused rather than split into words).
 */
export function fragmentTerm(raw: string): string | undefined {
  const typed = normaliseQuery(raw);
  if (!isFragmentShaped(typed)) return undefined;
  // A fragment-shaped string folds to itself; this only fixes its spacing.
  return foldWords(typed).join(' ');
}

/** The hidden term that keeps `term` out: one of its whole words or phrases. */
function blockerOf(term: string, hidden: Set<string>): string | undefined {
  return [...hidden].find(
    (word) => word !== term && ` ${term} `.includes(` ${word} `),
  );
}

export interface AdminFragmentView {
  term: string;
  /**
   * Different searchers in the current window, or the window before it if
   * that was more: a person counts once per window, whatever the days.
   */
  searchers: number;
  /** Hidden itself. */
  hidden: boolean;
  /** Kept out because it contains this hidden word or phrase. */
  blockedBy?: string;
  /** Shown to readers now: enough searchers, not hidden, matches public content. */
  shown: boolean;
}

interface Candidates {
  at: number;
  counted: Array<{ _id: string; searchers: number }>;
  hidden: Set<string>;
}

/**
 * Suggested Fragments that follow what people search (Chunk 15, plan D21),
 * privately:
 * - stored: one count per term per fixed window, and one row per (searcher,
 *   term, window) whose id is an HMAC under a key derived from the server
 *   secret (`fragment-keys.ts`, round-2 review M-A). The secret is not in
 *   the database, so the database alone names nobody and cannot test
 *   whether a given person searched a term; a restart does not count anyone
 *   twice;
 * - a term is counted only when EVERY word of it, as a phrase, is in belief
 *   text or an ORG page a SIGNED-OUT reader can see (review H1a; never in a
 *   member's name, round-2 review M-B), and shown only while it still is;
 * - a person counts once per window, however many days they search;
 * - it must have enough different searchers, pass the shape check, and
 *   neither be hidden nor contain a hidden word.
 *
 * A term is suggested while its count in the current window, or the window
 * just before it, reaches the threshold; the two counts are never added
 * (the same person may be in both).
 */
@Injectable()
export class SearchFragmentsService {
  private readonly logger = new Logger(SearchFragmentsService.name);
  private readonly minSearchers: number;
  private readonly windowDays: number;
  private readonly keys?: FragmentKeys;
  private cache?: Candidates;
  private eligible?: { key: string; at: number; fragments: string[] };
  /** Terms each searcher added this window: memory only, never stored. */
  private perVisitor = { window: -1, counts: new Map<string, number>() };

  constructor(
    @InjectModel(SearchTermWindow.name)
    private readonly windowModel: Model<SearchTermWindowDocument>,
    @InjectModel(SearchFragmentHide.name)
    private readonly hideModel: Model<SearchFragmentHideDocument>,
    private readonly search: SearchService,
    private readonly log: ModerationLogService,
    config: ConfigService,
    @InjectModel(SearchFragmentPair.name)
    private readonly pairModel: Model<SearchFragmentPairDocument>,
  ) {
    this.minSearchers = config.get<number>(
      'SEARCH_FRAGMENT_MIN_SEARCHERS',
      FRAGMENT_DEFAULTS.minSearchers,
    );
    this.windowDays = config.get<number>(
      'SEARCH_FRAGMENT_WINDOW_DAYS',
      FRAGMENT_DEFAULTS.windowDays,
    );
    const secret = fragmentSecret(config);
    if (secret) this.keys = new FragmentKeys(secret);
    else this.logger.warn(FRAGMENTS_OFF);
  }

  /**
   * Counts one search toward its term's fragment. Never throws: a search is
   * answered whether or not it could be counted.
   *
   * @param total - how many results THIS reader got; the public check is
   *   always a signed-out reader's, whoever searched
   * @param visitor - who searched; used only inside HMACs, never stored
   */
  async record(
    query: string,
    total: number,
    visitor: string,
    now = new Date(),
  ): Promise<void> {
    try {
      const term = fragmentTerm(query);
      if (total === 0 || !term || !this.keys) return;
      // Public first: a term that is not remembers nobody (round-2 review L1).
      if ((await this.search.publicPhraseCount(term)) === 0) return;
      const window = windowIndex(now, this.windowDays);
      if (!this.underVisitorLimit(window, visitor)) return;
      const expiresAt = new Date(((window + 1) * this.windowDays + 1) * DAY_MS);
      const pair = await this.pairModel
        .updateOne(
          { _id: this.keys.pairId(window, visitor, term) },
          { $setOnInsert: { expiresAt } },
          { upsert: true },
        )
        .exec();
      // Already counted for this term in this window, before or after a restart.
      if (pair.upsertedCount !== 1) return;
      this.countVisitor(window, visitor);
      await this.windowModel
        .updateOne(
          { _id: `${window}|${term}` },
          {
            $inc: { searchers: 1 },
            $setOnInsert: {
              term,
              window,
              expiresAt: new Date((window + 2) * this.windowDays * DAY_MS),
            },
          },
          { upsert: true },
        )
        .exec();
      // A count changed: the candidates are read again on the next request.
      this.cache = undefined;
    } catch (error) {
      this.logger.warn(
        `A search could not be counted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private visitorCounts(window: number) {
    if (this.perVisitor.window !== window) {
      this.perVisitor = { window, counts: new Map() };
    }
    return this.perVisitor.counts;
  }

  private underVisitorLimit(window: number, visitor: string) {
    const counts = this.visitorCounts(window);
    const id = (this.keys as FragmentKeys).visitorId(window, visitor);
    return (counts.get(id) ?? 0) < MAX_TERMS_PER_VISITOR;
  }

  private countVisitor(window: number, visitor: string) {
    const counts = this.visitorCounts(window);
    const id = (this.keys as FragmentKeys).visitorId(window, visitor);
    const known = counts.get(id);
    if (known === undefined && counts.size >= MAX_TRACKED_VISITORS) {
      // A Map keeps insertion order: its first key was seen longest ago.
      counts.delete(counts.keys().next().value as string);
    }
    counts.set(id, (known ?? 0) + 1);
  }

  /** The fragments readers see, most searched first; eligibility kept current. */
  async fragments(now = new Date()): Promise<string[]> {
    if (!this.keys) return [];
    if (
      !this.cache ||
      Math.abs(now.getTime() - this.cache.at) >= CANDIDATES_CACHE_MS
    ) {
      this.cache = await this.candidates(now);
    }
    const scope = await this.search.guestScope();
    const key = JSON.stringify([
      this.cache.at,
      this.search.indexGeneration(),
      scope.listed.map(String),
      scope.full.map(String),
    ]);
    if (
      this.eligible?.key === key &&
      Math.abs(now.getTime() - this.eligible.at) < ELIGIBLE_CACHE_MS
    ) {
      const still: string[] = [];
      for (const term of this.eligible.fragments) {
        if ((await this.search.publicPhraseCount(term, scope)) > 0) {
          still.push(term);
        }
      }
      if (still.length === this.eligible.fragments.length) return still;
      // One went: run the full pass, so the next candidate can take its place.
    }
    const views = await this.check(this.cache, true, scope);
    const fragments = views
      .filter((view) => view.shown)
      .map((view) => view.term);
    this.eligible = { key, at: now.getTime(), fragments };
    return fragments;
  }

  /** Every term with enough searchers, and every hidden one, for the admins. */
  async adminView(now = new Date()): Promise<AdminFragmentView[]> {
    const fresh = await this.candidates(now);
    const views = await this.check(fresh, false);
    for (const term of fresh.hidden) {
      if (!views.some((view) => view.term === term)) {
        views.push({ term, searchers: 0, hidden: true, shown: false });
      }
    }
    return views;
  }

  private async candidates(now: Date): Promise<Candidates> {
    const current = windowIndex(now, this.windowDays);
    const counted = await this.windowModel
      .aggregate<{ _id: string; searchers: number }>([
        { $match: { window: { $in: [current - 1, current] } } },
        // The larger of the two windows, never their sum.
        { $group: { _id: '$term', searchers: { $max: '$searchers' } } },
        { $match: { searchers: { $gte: this.minSearchers } } },
        { $sort: { searchers: -1, _id: 1 } },
        { $limit: MAX_CANDIDATES },
      ])
      .exec();
    const hiddenRows = await this.hideModel
      .find({ hidden: true })
      .select({ _id: 1 })
      .lean()
      .exec();
    return {
      at: now.getTime(),
      counted,
      hidden: new Set(hiddenRows.map((row) => row._id)),
    };
  }

  /**
   * Each candidate's state now. One guest scope is read (or given) and shared
   * by every check; checking stops once {@link MAX_FRAGMENTS} are shown.
   *
   * @param stopAtShown - leave out the rest once enough are shown
   */
  private async check(
    { counted, hidden }: Candidates,
    stopAtShown: boolean,
    given?: SearchScope,
  ): Promise<AdminFragmentView[]> {
    let scope = given;
    const views: AdminFragmentView[] = [];
    let shownCount = 0;
    for (const row of counted) {
      if (stopAtShown && shownCount === MAX_FRAGMENTS) break;
      const isHidden = hidden.has(row._id);
      const blockedBy = blockerOf(row._id, hidden);
      const eligible =
        !isHidden &&
        !blockedBy &&
        shownCount < MAX_FRAGMENTS &&
        isFragmentShaped(row._id);
      if (eligible) scope ??= await this.search.guestScope();
      const shown =
        eligible && (await this.search.publicPhraseCount(row._id, scope)) > 0;
      if (shown) shownCount += 1;
      views.push({
        term: row._id,
        searchers: row.searchers,
        hidden: isHidden,
        ...(blockedBy ? { blockedBy } : {}),
        shown,
      });
    }
    return views;
  }

  /**
   * Hides a fragment or shows it again, and logs it in the moderation log.
   * Any fragment-shaped term can be hidden, including one nobody has
   * searched yet; a hidden word or phrase also keeps out every term that
   * contains it as whole words.
   *
   * @throws BadRequestException for a term that could never be a fragment
   */
  async setHidden(
    rawTerm: string,
    hidden: boolean,
    adminUserId: string,
    reason?: string,
  ): Promise<{ term: string; hidden: boolean }> {
    const term = fragmentTerm(rawTerm);
    if (!term) {
      throw new BadRequestException(FRAGMENT_NOT_SHAPED);
    }
    await this.hideModel
      .updateOne(
        { _id: term },
        { $set: { hidden, at: new Date(), by: adminUserId } },
        { upsert: true },
      )
      .exec();
    await this.log.record({
      actorUserId: adminUserId,
      action: hidden ? 'search.fragment.hidden' : 'search.fragment.shown',
      targetType: 'search-fragment',
      targetId: term,
      reason: reason?.trim() || DEFAULT_HIDE_REASON,
    });
    this.cache = undefined;
    return { term, hidden };
  }
}
