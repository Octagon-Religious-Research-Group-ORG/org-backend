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
  SearchTermWindow,
  type SearchTermWindowDocument,
} from './schemas/search-term-window.schema';
import type { SearchScope } from './search-pipeline';
import { SearcherCounter } from './searcher-counter';
import { SearchService } from './search.service';
import { foldWords, isFragmentShaped, normaliseQuery } from './search-text';

/** Defaults for the two settings (`SEARCH_FRAGMENT_*`). */
export const FRAGMENT_DEFAULTS = { minSearchers: 5, windowDays: 30 };
/** Fragments the Perforated Index shows at most. */
export const MAX_FRAGMENTS = 8;
/** Candidates read per listing, most-searched first. */
const MAX_CANDIDATES = 50;
/**
 * How long the list of CANDIDATES (counts and hidden terms) is kept. Whether
 * each one still matches public content is checked on every request, so a
 * term whose page went private is dropped at once (review L4).
 */
export const CANDIDATES_CACHE_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

export const FRAGMENT_NOT_SHAPED =
  'That is not a term a fragment can be: 3–40 letters, digits, spaces, hyphens or apostrophes, at most four words.';
export const DEFAULT_HIDE_REASON = 'No reason given.';

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

export interface AdminFragmentView {
  term: string;
  /**
   * Different searchers in the current window, or the window before it if
   * that was more: a person counts once per window, whatever the days.
   */
  searchers: number;
  hidden: boolean;
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
 * - only aggregate counts are stored: one row per term per fixed window,
 *   never a query with a user, address or session;
 * - a term is counted only when EVERY word of it, as a phrase, is in content
 *   a SIGNED-OUT reader can see (review H1a), and shown only while it still
 *   is, so a private word can never surface, alone or next to public ones;
 * - a person counts once per window, however many days they search
 *   (review H1b);
 * - it must have enough different searchers, pass the shape check, and not
 *   be hidden by an admin.
 *
 * A term is suggested while its count in the current window, or the window
 * just before it, reaches the threshold: so a popular term does not vanish
 * on the first day of a new window, and counts from two windows are never
 * added together (the same person may be in both).
 */
@Injectable()
export class SearchFragmentsService {
  private readonly logger = new Logger(SearchFragmentsService.name);
  private readonly minSearchers: number;
  private readonly windowDays: number;
  private cache?: Candidates;
  /** In memory only: see searcher-counter.ts. */
  private readonly counter = new SearcherCounter();

  constructor(
    @InjectModel(SearchTermWindow.name)
    private readonly windowModel: Model<SearchTermWindowDocument>,
    @InjectModel(SearchFragmentHide.name)
    private readonly hideModel: Model<SearchFragmentHideDocument>,
    private readonly search: SearchService,
    private readonly log: ModerationLogService,
    config: ConfigService,
  ) {
    this.minSearchers = config.get<number>(
      'SEARCH_FRAGMENT_MIN_SEARCHERS',
      FRAGMENT_DEFAULTS.minSearchers,
    );
    this.windowDays = config.get<number>(
      'SEARCH_FRAGMENT_WINDOW_DAYS',
      FRAGMENT_DEFAULTS.windowDays,
    );
  }

  /**
   * Counts one search toward its term's fragment. Never throws: a search is
   * answered whether or not it could be counted.
   *
   * @param total - how many results THIS reader got; the public check is
   *   always a signed-out reader's, whoever searched
   * @param visitor - who searched, for the in-memory distinct count only
   */
  async record(
    query: string,
    total: number,
    visitor: string,
    now = new Date(),
  ): Promise<void> {
    try {
      const term = fragmentTerm(query);
      if (total === 0 || !term) return;
      const window = windowIndex(now, this.windowDays);
      if (!this.counter.firstInWindow(term, visitor, String(window))) return;
      if ((await this.search.publicPhraseCount(term)) === 0) return;
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

  /** The fragments readers see, most searched first; eligibility checked now. */
  async fragments(now = new Date()): Promise<string[]> {
    if (
      !this.cache ||
      Math.abs(now.getTime() - this.cache.at) >= CANDIDATES_CACHE_MS
    ) {
      this.cache = await this.candidates(now);
    }
    const views = await this.check(this.cache, true);
    return views.filter((view) => view.shown).map((view) => view.term);
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
   * Each candidate's state now. One guest scope is read and shared by every
   * check; checking stops once {@link MAX_FRAGMENTS} are shown.
   *
   * @param stopAtShown - leave out the rest once enough are shown
   */
  private async check(
    { counted, hidden }: Candidates,
    stopAtShown: boolean,
  ): Promise<AdminFragmentView[]> {
    let scope: SearchScope | undefined;
    const views: AdminFragmentView[] = [];
    let shownCount = 0;
    for (const row of counted) {
      if (stopAtShown && shownCount === MAX_FRAGMENTS) break;
      const isHidden = hidden.has(row._id);
      const eligible =
        !isHidden && shownCount < MAX_FRAGMENTS && isFragmentShaped(row._id);
      if (eligible) scope ??= await this.search.guestScope();
      const shown =
        eligible && (await this.search.publicPhraseCount(row._id, scope)) > 0;
      if (shown) shownCount += 1;
      views.push({
        term: row._id,
        searchers: row.searchers,
        hidden: isHidden,
        shown,
      });
    }
    return views;
  }

  /**
   * Hides a fragment or shows it again, and logs it in the moderation log.
   * Any fragment-shaped term can be hidden, including one nobody has
   * searched yet, so an admin can act ahead.
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
