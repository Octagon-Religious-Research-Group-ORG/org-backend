import type { Element } from '@xmldom/xmldom';
import { attr, children, firstChild } from './xml';

/** One level of a Word list definition (`w:lvl`). */
interface ListLevel {
  start: number;
  format: string;
  text: string;
}

/**
 * Word list numbering (`word/numbering.xml`): turns a paragraph's
 * (numId, level) into the label Word would display, e.g. "II." or "A.".
 *
 * Counters belong to the abstract list a numId points at, so two numIds that
 * share one abstract list continue the same count (Word's behaviour). A
 * paragraph at a level resets every deeper level of that list.
 */
export class DocxNumbering {
  private readonly abstractOf = new Map<string, string>();
  private readonly levels = new Map<string, Map<number, ListLevel>>();
  private readonly counters = new Map<string, number[]>();

  constructor(numberingXml?: Element) {
    if (!numberingXml) return;
    // A list may define no levels itself and point at a list style by name
    // (`w:numStyleLink`); the list that DOES define the levels names the same
    // style in `w:styleLink`. Pages exports its outlines this way.
    const definedByStyle = new Map<string, string>();
    const linkedTo = new Map<string, string>();
    for (const abstract of children(numberingXml, 'w:abstractNum')) {
      const id = attr(abstract, 'w:abstractNumId');
      if (id === undefined) continue;
      const defines = attr(firstChild(abstract, 'w:styleLink'), 'w:val');
      const uses = attr(firstChild(abstract, 'w:numStyleLink'), 'w:val');
      if (defines) definedByStyle.set(defines, id);
      if (uses) linkedTo.set(id, uses);
    }
    for (const abstract of children(numberingXml, 'w:abstractNum')) {
      const id = attr(abstract, 'w:abstractNumId');
      const byLevel = new Map<number, ListLevel>();
      for (const lvl of children(abstract, 'w:lvl')) {
        byLevel.set(Number(attr(lvl, 'w:ilvl') ?? 0), {
          start: Number(attr(firstChild(lvl, 'w:start'), 'w:val') ?? 1),
          format: attr(firstChild(lvl, 'w:numFmt'), 'w:val') ?? 'decimal',
          text: attr(firstChild(lvl, 'w:lvlText'), 'w:val') ?? '',
        });
      }
      if (id !== undefined) this.levels.set(id, byLevel);
    }
    for (const num of children(numberingXml, 'w:num')) {
      const numId = attr(num, 'w:numId');
      const declared = attr(firstChild(num, 'w:abstractNumId'), 'w:val');
      if (numId === undefined || declared === undefined) continue;
      const style = linkedTo.get(declared);
      const resolved = style ? definedByStyle.get(style) : undefined;
      this.abstractOf.set(numId, resolved ?? declared);
    }
  }

  /**
   * Advances the list counter and returns the label for one paragraph, or
   * undefined when the list is unknown or numId 0 ("no numbering").
   */
  next(numId: string, level: number): string | undefined {
    const abstractId = this.abstractOf.get(numId);
    // Abstract list ids start at "0", so test for absence, not falsiness.
    if (abstractId === undefined) return undefined;
    const levels = this.levels.get(abstractId);
    if (!levels?.has(level)) return undefined;

    const definition = levels.get(level)!;
    const counts = this.counters.get(abstractId) ?? [];
    for (let deeper = level + 1; deeper < counts.length; deeper++) {
      counts[deeper] = 0;
    }
    counts[level] = counts[level] ? counts[level] + 1 : definition.start;
    this.counters.set(abstractId, counts);

    if (definition.format === 'bullet' || definition.format === 'none') {
      return '';
    }
    return definition.text.replace(/%(\d)/g, (_match, digit: string) => {
      const at = Number(digit) - 1;
      const format = levels.get(at)?.format ?? 'decimal';
      const value = counts[at] || (levels.get(at)?.start ?? 1);
      return formatNumber(value, format);
    });
  }
}

/** Formats a counter value the way Word's numFmt does. */
export function formatNumber(value: number, format: string): string {
  switch (format) {
    case 'upperRoman':
      return toRoman(value);
    case 'lowerRoman':
      return toRoman(value).toLowerCase();
    case 'upperLetter':
      return toLetters(value);
    case 'lowerLetter':
      return toLetters(value).toLowerCase();
    default:
      return String(value);
  }
}

function toRoman(value: number): string {
  const table: [number, string][] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let rest = value;
  let out = '';
  for (const [amount, symbol] of table) {
    while (rest >= amount) {
      out += symbol;
      rest -= amount;
    }
  }
  return out;
}

/** 1 → A, 26 → Z, 27 → AA (Word repeats the letter). */
function toLetters(value: number): string {
  const letter = String.fromCharCode(65 + ((value - 1) % 26));
  return letter.repeat(Math.floor((value - 1) / 26) + 1);
}
