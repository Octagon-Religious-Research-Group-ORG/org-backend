import { createHmac, randomBytes } from 'node:crypto';

/** Distinct (term, searcher) pairs remembered per window before counting stops. */
export const MAX_TRACKED_PAIRS = 50_000;

/**
 * Tells whether a searcher is NEW for a term in the current window, without
 * storing who they are anywhere (Chunk 15, plan D21; review H1b).
 *
 * The window is fixed (`SEARCH_FRAGMENT_WINDOW_DAYS` days, see
 * `windowIndex`), so a person who searches a term on every day of it counts
 * once, not once a day.
 *
 * Why this design: the database must never hold a query next to a person,
 * and even a salted hash stored beside a term would let anyone holding the
 * salt link one person's searches. So the pairs live ONLY in this process's
 * memory, keyed by an HMAC whose key is random, made when the window starts
 * and never written down. When the window ends the key and every pair are
 * dropped; what remains is one count per term per window.
 *
 * Costs, accepted on purpose and stated in the README:
 * - a restart forgets the window's pairs, so a person searching the same
 *   term before and after it counts twice;
 * - each server instance counts on its own (Render's free plan runs one);
 * - the pairs stay in memory for up to a whole window, bounded by
 *   {@link MAX_TRACKED_PAIRS}; past it, nobody new is counted until the
 *   window ends.
 * Each can only raise a count or stop counting; none can attach a person to
 * a term.
 */
export class SearcherCounter {
  private window = '';
  private key: Buffer = Buffer.alloc(0);
  private readonly pairs = new Set<string>();

  constructor(private readonly makeKey: () => Buffer = () => randomBytes(32)) {}

  /**
   * @param visitor - the signed-in user's id or the visitor's address; used
   *   only inside the HMAC, never kept
   * @param window - which fixed window it is now (`windowIndex`)
   * @returns true the first time this visitor searches this term in this
   *   window; false for a repeat, or once the window's memory is full
   */
  firstInWindow(term: string, visitor: string, window: string): boolean {
    if (window !== this.window) {
      this.window = window;
      this.key = this.makeKey();
      this.pairs.clear();
    }
    const pair = createHmac('sha256', this.key)
      .update(`${visitor}\u0000${term}`)
      .digest('base64url')
      .slice(0, 22);
    if (this.pairs.has(pair) || this.pairs.size >= MAX_TRACKED_PAIRS) {
      return false;
    }
    this.pairs.add(pair);
    return true;
  }
}
