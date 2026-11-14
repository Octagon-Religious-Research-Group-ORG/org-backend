import {
  highlightRanges,
  isFragmentShaped,
  makeSnippet,
  normaliseQuery,
  queryTerms,
  SNIPPET_LENGTH,
  utcDay,
} from './search-text';

describe('search text', () => {
  it('normalises case, accents, width, controls and spaces', () => {
    expect(normaliseQuery('  Thé\u0000  ＬＡＭＰ\tlight ')).toBe(
      'the lamp light',
    );
  });

  it('splits a query into unique words without edge punctuation', () => {
    expect(queryTerms('"lamp" -light, lamp it\'s ...')).toEqual([
      'lamp',
      'light',
      "it's",
    ]);
    expect(queryTerms('a b c d e f g h i j')).toHaveLength(8);
    expect(queryTerms('... ---')).toEqual([]);
  });

  it('finds and merges matches, accents folded', () => {
    expect(
      highlightRanges('Lampe and LAMP, lamplight', ['lamp', 'lampl']),
    ).toEqual([
      { start: 0, end: 4 },
      { start: 10, end: 14 },
      { start: 16, end: 21 },
    ]);
    expect(highlightRanges('Thé', ['the'])).toEqual([{ start: 0, end: 3 }]);
    // A fold that changes the length cannot give true offsets: none.
    expect(highlightRanges('\u{1D400}x', ['x'])).toEqual([]);
    expect(highlightRanges('ﬁx', ['x'])).toEqual([{ start: 1, end: 2 }]);
  });

  it('cuts a snippet around the first match', () => {
    const long = `${'a '.repeat(200)}target ${'b '.repeat(200)}`;
    const { snippet, highlights } = makeSnippet(long, ['target']);
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBe(SNIPPET_LENGTH + 2);
    expect(snippet.slice(highlights[0].start, highlights[0].end)).toBe(
      'target',
    );
    expect(makeSnippet('short  text', ['none'])).toEqual({
      snippet: 'short text',
      highlights: [],
    });
    const end = makeSnippet(`${'c '.repeat(200)}tail`, ['tail']).snippet;
    expect(end.endsWith('tail')).toBe(true);
  });

  it('accepts only topic-shaped fragments', () => {
    expect(isFragmentShaped('lamp light')).toBe(true);
    expect(isFragmentShaped("it's self-made")).toBe(true);
    expect(isFragmentShaped('ab')).toBe(false);
    expect(isFragmentShaped('x'.repeat(41))).toBe(false);
    expect(isFragmentShaped('a@b.test')).toBe(false);
    expect(isFragmentShaped('one two three four five')).toBe(false);
    expect(isFragmentShaped('123')).toBe(false);
    expect(isFragmentShaped('call 5551234')).toBe(false);
  });

  it('names the UTC day', () => {
    expect(utcDay(new Date('2026-11-13T23:59:59Z'))).toBe('2026-11-13');
  });
});
