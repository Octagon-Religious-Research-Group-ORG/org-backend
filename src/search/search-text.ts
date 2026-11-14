/**
 * Text helpers for search (Chunk 15): one normal form for what a reader
 * types, the snippet a result shows, and where its matches sit.
 *
 * Every snippet is cut from text the visibility filter has already let
 * through, so nothing here can show a reader text they may not see.
 */

/** Longest query accepted, in characters after normalising. */
export const MAX_QUERY_LENGTH = 100;
/** Shortest useful query. */
export const MIN_QUERY_LENGTH = 2;
/** More words than this are dropped: a query is a few words, not a page. */
export const MAX_QUERY_TERMS = 8;
/** Characters of context a snippet shows. */
export const SNIPPET_LENGTH = 180;

const INVISIBLE = /[\p{C}\p{M}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * NFKC, lower case, controls and combining marks out, whitespace collapsed.
 * Accents are folded ("Thé" reads as "the") so a fragment does not split
 * into near-duplicates.
 */
export function normaliseQuery(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .normalize('NFKD')
    .replace(INVISIBLE, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The words of any text in the ONE form every engine searches: normalised
 * (accents folded, lower case), split on anything but letters, digits,
 * apostrophes and hyphens, with apostrophes and hyphens trimmed from each
 * word's ends. A query and the text it should find go through the same
 * function, so a quote or a leading `-` can never act as an operator and
 * "café" matches "cafe" on every engine (review L1, L2).
 */
export function foldWords(raw: string): string[] {
  return normaliseQuery(raw)
    .replace(/[^\p{L}\p{N}'-]+/gu, ' ')
    .split(' ')
    .map((word) => word.replace(/^['-]+|['-]+$/g, ''))
    .filter((word) => word.length > 0);
}

/**
 * The searchable copy of a text: its folded words, space-separated and
 * padded with a space at each end, so ` <phrase> ` is a whole-word phrase
 * match (`search-pipeline.ts` `phraseStages`).
 */
export function foldedText(raw: string): string {
  return ` ${foldWords(raw).join(' ')} `;
}

/** The words of a query, without repeats, at most {@link MAX_QUERY_TERMS}. */
export function queryTerms(query: string): string[] {
  return [...new Set(foldWords(query))].slice(0, MAX_QUERY_TERMS);
}

/** Lower case with accents folded, keeping one character per character. */
function foldForMatch(text: string): string {
  return [...text]
    .map((char) => {
      const folded = char
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase();
      // Only a one-for-one fold keeps offsets right; anything else stays.
      return [...folded].length === 1 ? folded : char.toLowerCase();
    })
    .join('');
}

export interface Highlight {
  start: number;
  end: number;
}

/**
 * Where the query's words appear in `text`, as code-unit offsets, merged so
 * ranges never overlap.
 */
export function highlightRanges(text: string, terms: string[]): Highlight[] {
  const haystack = foldForMatch(text);
  if (haystack.length !== text.length) return [];
  const found: Highlight[] = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(term, from);
      if (at < 0) break;
      found.push({ start: at, end: at + term.length });
      from = at + term.length;
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Highlight[] = [];
  for (const range of found) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Up to {@link SNIPPET_LENGTH} characters of `text` around its first match,
 * with an ellipsis where it was cut, and the matches inside it.
 */
export function makeSnippet(
  text: string,
  terms: string[],
): { snippet: string; highlights: Highlight[] } {
  const flat = text.replace(/\s+/g, ' ').trim();
  const first = highlightRanges(flat, terms).at(0)?.start ?? 0;
  let start = Math.max(0, first - Math.floor(SNIPPET_LENGTH / 3));
  const end = Math.min(flat.length, start + SNIPPET_LENGTH);
  start = Math.max(0, end - SNIPPET_LENGTH);
  const snippet = `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
  return { snippet, highlights: highlightRanges(snippet, terms) };
}

/** Shortest and longest term that can become a Suggested Fragment. */
export const FRAGMENT_MIN_LENGTH = 3;
export const FRAGMENT_MAX_LENGTH = 40;
export const FRAGMENT_MAX_WORDS = 4;

/**
 * Letters, digits, single spaces, hyphens and apostrophes, 3–40 characters,
 * at most four words, and at least one letter. Anything that looks like an
 * address, a number or a code (an `@`, a run of digits) is refused: a
 * fragment is a topic, never a contact detail.
 */
export function isFragmentShaped(term: string): boolean {
  if (term.length < FRAGMENT_MIN_LENGTH || term.length > FRAGMENT_MAX_LENGTH) {
    return false;
  }
  if (!/^[\p{L}\p{N}]+(?:[ '-][\p{L}\p{N}]+)*$/u.test(term)) return false;
  if (term.split(' ').length > FRAGMENT_MAX_WORDS) return false;
  if (!/\p{L}/u.test(term)) return false;
  return !/\p{N}{4,}/u.test(term);
}

/** The UTC day of `at`, as `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}
