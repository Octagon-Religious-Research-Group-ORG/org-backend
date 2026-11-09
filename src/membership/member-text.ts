import { toStorableText } from '../social/version-chain';

/**
 * Characters that show nothing on screen: controls and format characters
 * (zero-width spaces and joiners), separators, combining marks with no letter
 * under them, default-ignorable code points (Hangul filler, variation
 * selectors) and the blank Braille cell.
 */
const INVISIBLE = /[\p{C}\p{Z}\p{M}\p{Default_Ignorable_Code_Point}⠀]/gu;

/**
 * Control characters, and the bidirectional overrides that make text read
 * differently from what it stores. Line breaks and tabs are handled apart.
 */
const STRIPPED_CONTROLS =
  // eslint-disable-next-line no-control-regex -- matching them is the point
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const LINE_BREAKS_AND_TABS = /[\t\n\v\f\r\u2028\u2029]+/g;

/**
 * A title as it is stored: one line, no control characters, no lone
 * surrogates, no bidirectional overrides.
 */
export function cleanMemberTitle(text: string): string {
  return toStorableText(text)
    .replace(STRIPPED_CONTROLS, '')
    .replace(LINE_BREAKS_AND_TABS, ' ')
    .trim();
}

/**
 * Paragraph text as it is stored: the same rules as a title, except that
 * line breaks stay, because a blank line is what separates paragraphs.
 */
export function cleanMemberParagraphs(text: string): string {
  return toStorableText(text)
    .replace(STRIPPED_CONTROLS, '')
    .replace(/[\v\f\u2028\u2029]/g, '\n');
}

/** True when the text has at least one character a reader would see. */
export function hasVisibleText(text: string): boolean {
  return text.replace(INVISIBLE, '') !== '';
}

/**
 * Letters from other alphabets that look like Latin ones, so a name written
 * with them reads the same as an existing member's. Not exhaustive: the check
 * only raises a flag for the admin reviewing the page.
 */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  а: 'a',
  в: 'b',
  с: 'c',
  е: 'e',
  ё: 'e',
  һ: 'h',
  і: 'i',
  ј: 'j',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  ѕ: 's',
  т: 't',
  у: 'y',
  х: 'x',
  α: 'a',
  β: 'b',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  '0': 'o',
  '1': 'l',
};

/** A name reduced to how it reads: case, accents, spacing and alphabet gone. */
export function nameSkeleton(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/./gu, (char) => LOOK_ALIKES[char] ?? char)
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Shorter names must match exactly; one letter is too much of a short name. */
export const NEAR_DUPLICATE_MIN_LENGTH = 5;

function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;
  let start = 0;
  while (start < short.length && short[start] === long[start]) start++;
  const shortRest = short.slice(start);
  const longRest = long.slice(start + 1);
  return (
    shortRest === longRest || // one letter added
    (short.length === long.length && shortRest.slice(1) === longRest) // one replaced
  );
}

/**
 * Do two display names read as the same person? True when they are identical
 * once reduced to their skeleton, or one letter apart for longer names.
 */
export function isNearDuplicateName(a: string, b: string): boolean {
  const left = nameSkeleton(a);
  const right = nameSkeleton(b);
  if (left === '' || right === '') return false;
  if (Math.min(left.length, right.length) < NEAR_DUPLICATE_MIN_LENGTH) {
    return left === right;
  }
  return withinOneEdit(left, right);
}
