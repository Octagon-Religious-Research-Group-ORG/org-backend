import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { GUEST_VIEWER, type Viewer } from '../members/profile-access';
import { ModerationLogService } from '../moderation/moderation-log.service';
import {
  SearchFragmentHide,
  type SearchFragmentHideDocument,
} from './schemas/search-fragment-hide.schema';
import {
  SearchTermDay,
  type SearchTermDayDocument,
} from './schemas/search-term-day.schema';
import { SearcherCounter } from './searcher-counter';
import { SearchService } from './search.service';
import { isFragmentShaped, normaliseQuery, utcDay } from './search-text';

/** Defaults for the two settings (`SEARCH_FRAGMENT_*`). */
export const FRAGMENT_DEFAULTS = { minSearchers: 5, windowDays: 30 };
/** Fragments the Perforated Index shows at most. */
export const MAX_FRAGMENTS = 8;
/** Candidates read per listing, most-searched first. */
const MAX_CANDIDATES = 50;
/** The public list is rebuilt at most this often. */
export const FRAGMENTS_CACHE_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

export const FRAGMENT_NOT_SHAPED =
  'That is not a term a fragment can be: 3–40 letters, digits, spaces, hyphens or apostrophes, at most four words.';
export const DEFAULT_HIDE_REASON = 'No reason given.';

export interface AdminFragmentView {
  term: string;
  /** Different searchers in the window (a day's repeat searches count once). */
  searchers: number;
  hidden: boolean;
  /** Shown to readers now: enough searchers, not hidden, matches public content. */
  shown: boolean;
}

/**
 * Suggested Fragments that follow what people search (Chunk 15, plan D21),
 * privately:
 * - only aggregate counts are stored: one row per normalised term per UTC
 *   day, never a query with a user, address or session;
 * - a term is counted only when it matched content a SIGNED-OUT reader can
 *   see, and is shown only while it still does, so a private word can never
 *   surface from a member's own searches;
 * - it must have enough different searchers in the window, pass the shape
 *   check, and not be hidden by an admin.
 */
@Injectable()
export class SearchFragmentsService {
  private readonly logger = new Logger(SearchFragmentsService.name);
  private readonly minSearchers: number;
  private readonly windowDays: number;
  private cache?: { at: number; fragments: string[] };
  /** In memory only: see searcher-counter.ts. */
  private readonly counter = new SearcherCounter();

  constructor(
    @InjectModel(SearchTermDay.name)
    private readonly dayModel: Model<SearchTermDayDocument>,
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
   * @param total - how many results THIS reader got
   * @param visitor - who searched, for the in-memory distinct count only
   */
  async record(
    term: string,
    total: number,
    viewer: Viewer,
    visitor: string,
    now = new Date(),
  ): Promise<void> {
    try {
      if (total === 0 || !isFragmentShaped(term)) return;
      if (!this.counter.firstToday(term, visitor, now)) return;
      const publicTotal =
        viewer.kind === 'guest'
          ? total
          : await this.search.count(term, GUEST_VIEWER);
      if (publicTotal === 0) return;
      const day = utcDay(now);
      await this.dayModel
        .updateOne(
          { _id: `${day}|${term}` },
          {
            $inc: { searchers: 1 },
            $setOnInsert: {
              term,
              day,
              expiresAt: new Date(
                Date.parse(day) + (this.windowDays + 1) * DAY_MS,
              ),
            },
          },
          { upsert: true },
        )
        .exec();
    } catch (error) {
      this.logger.warn(
        `A search could not be counted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The fragments readers see, most searched first. */
  async fragments(now = new Date()): Promise<string[]> {
    if (this.cache && now.getTime() - this.cache.at < FRAGMENTS_CACHE_MS) {
      return this.cache.fragments;
    }
    const rows = await this.adminView(now);
    const fragments = rows
      .filter((row) => row.shown)
      .slice(0, MAX_FRAGMENTS)
      .map((row) => row.term);
    this.cache = { at: now.getTime(), fragments };
    return fragments;
  }

  /** Every term with enough searchers, and every hidden one, for the admins. */
  async adminView(now = new Date()): Promise<AdminFragmentView[]> {
    const firstDay = utcDay(
      new Date(now.getTime() - (this.windowDays - 1) * DAY_MS),
    );
    const counted = await this.dayModel
      .aggregate<{
        _id: string;
        searchers: number;
      }>([
        { $match: { day: { $gte: firstDay } } },
        { $group: { _id: '$term', searchers: { $sum: '$searchers' } } },
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
    const hidden = new Set(hiddenRows.map((row) => row._id));
    const views: AdminFragmentView[] = [];
    let shownCount = 0;
    for (const row of counted) {
      const isHidden = hidden.has(row._id);
      // Checked now, not when counted: a page made private since then drops
      // its words at once. Only as many as can be shown are checked.
      const shown =
        !isHidden &&
        shownCount < MAX_FRAGMENTS &&
        isFragmentShaped(row._id) &&
        (await this.search.count(row._id, GUEST_VIEWER)) > 0;
      if (shown) shownCount += 1;
      views.push({
        term: row._id,
        searchers: row.searchers,
        hidden: isHidden,
        shown,
      });
    }
    for (const term of hidden) {
      if (!views.some((view) => view.term === term)) {
        views.push({ term, searchers: 0, hidden: true, shown: false });
      }
    }
    return views;
  }

  /**
   * Hides a fragment or shows it again, and logs it in the moderation log.
   *
   * @throws BadRequestException for a term that could never be a fragment
   */
  async setHidden(
    rawTerm: string,
    hidden: boolean,
    adminUserId: string,
    reason?: string,
  ): Promise<{ term: string; hidden: boolean }> {
    const term = normaliseQuery(rawTerm);
    if (!isFragmentShaped(term)) {
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
