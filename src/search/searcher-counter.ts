import { createHmac, randomBytes } from 'node:crypto';
import { utcDay } from './search-text';

/** Distinct (term, searcher) pairs remembered per day before counting stops. */
export const MAX_TRACKED_PAIRS = 50_000;

/**
 * Tells whether a searcher is NEW for a term today, without storing who they
 * are anywhere (Chunk 15, plan D21).
 *
 * Why this design: the database must never hold a query next to a person,
 * and even a salted hash stored beside a term would let anyone holding the
 * salt link one person's searches within a day. So the pairs live ONLY in
 * this process's memory, keyed by an HMAC whose key is random, made at the
 * first search of each UTC day and never written down. At the next day the
 * key and every pair are dropped; what remains is a count per term and day.
 *
 * Costs, accepted on purpose: a restart forgets the day's pairs, so a person
 * searching the same term before and after it counts twice; and each server
 * instance counts on its own (Render's free plan runs one). Both can only
 * raise a count, which the threshold's conservative default absorbs, and
 * neither can attach a person to a term.
 */
export class SearcherCounter {
  private day = '';
  private key: Buffer = Buffer.alloc(0);
  private readonly pairs = new Set<string>();

  constructor(private readonly makeKey: () => Buffer = () => randomBytes(32)) {}

  /**
   * @param visitor - the signed-in user's id or the visitor's address; used
   *   only inside the HMAC, never kept
   * @returns true the first time this visitor searches this term today;
   *   false for a repeat, or once the day's memory is full
   */
  firstToday(term: string, visitor: string, now: Date): boolean {
    const today = utcDay(now);
    if (today !== this.day) {
      this.day = today;
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
