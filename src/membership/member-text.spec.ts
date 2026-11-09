import {
  cleanMemberParagraphs,
  cleanMemberTitle,
  hasVisibleText,
  isNearDuplicateName,
  nameSkeleton,
} from './member-text';

describe('cleanMemberTitle', () => {
  it('makes one clean line', () => {
    expect(cleanMemberTitle(' A\u0000\u0007B\u202Ec\nd\tE\r\nF ')).toBe(
      'ABc d E F',
    );
  });

  it('removes every bidirectional override and isolate', () => {
    expect(
      cleanMemberTitle(
        'a\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069b',
      ),
    ).toBe('ab');
  });

  it('replaces a lone surrogate, as the version store does', () => {
    expect(cleanMemberTitle('a\uD800b')).toBe('a\uFFFDb');
  });

  it('leaves ordinary text and joined emoji alone', () => {
    expect(cleanMemberTitle('Theology 🧑‍🚀 é')).toBe('Theology 🧑‍🚀 é');
  });
});

describe('cleanMemberParagraphs', () => {
  it('keeps line breaks and strips the rest', () => {
    expect(cleanMemberParagraphs('a\u0000\nb\u0007\n\nc\u202E')).toBe(
      'a\nb\n\nc',
    );
  });

  it('reads unusual line separators as line breaks', () => {
    expect(cleanMemberParagraphs('a\u2028b\u2029c\vd\fe')).toBe(
      'a\nb\nc\nd\ne',
    );
  });

  it('replaces a lone surrogate', () => {
    expect(cleanMemberParagraphs('a\uDC00')).toBe('a\uFFFD');
  });
});

describe('hasVisibleText', () => {
  it.each([
    ['zero-width space', '​'],
    ['zero-width joiner and non-joiner', '‍‌'],
    ['byte order mark', '﻿'],
    ['non-breaking space', ' '],
    ['Hangul filler', 'ㅤ'],
    ['blank Braille cell', '⠀'],
    ['a combining mark alone', '́'],
    ['a variation selector', '️'],
    ['spaces and line breaks', ' \n\t '],
  ])('is false for %s', (_label, text) => {
    expect(hasVisibleText(text)).toBe(false);
  });

  it.each(['A', '日本', '🙂', 'a​', '!'])('is true for %j', (text) => {
    expect(hasVisibleText(text)).toBe(true);
  });
});

describe('nameSkeleton', () => {
  it('reduces case, accents, spacing and punctuation', () => {
    expect(nameSkeleton('  Sóme-​Member! ')).toBe('somemember');
  });

  it('reads Cyrillic and Greek look-alikes as Latin', () => {
    expect(nameSkeleton('Sоmе Меmbеr')).toBe(nameSkeleton('Some Member'));
    expect(nameSkeleton('Sοme Member')).toBe(nameSkeleton('Some Member'));
  });

  it('keeps names in other alphabets', () => {
    expect(nameSkeleton('日本')).toBe('日本');
  });
});

describe('isNearDuplicateName', () => {
  it('matches the same name written differently', () => {
    expect(isNearDuplicateName('Quiet Harbor', 'quiet  harbor ')).toBe(true);
    expect(isNearDuplicateName('Quiet Harbor', 'Quiеt Hаrbor')).toBe(true);
  });

  it.each([
    ['one letter replaced', 'Quiet Harbor', 'Quiet Harbar'],
    ['one letter added', 'Quiet Harbor', 'Quiet Harbors'],
    ['one letter missing', 'Quiet Harbors', 'Quiet Harbor'],
    ['one letter added at the start', 'Quiet Harbor', 'XQuiet Harbor'],
  ])('matches %s', (_label, a, b) => {
    expect(isNearDuplicateName(a, b)).toBe(true);
  });

  it.each([
    ['two letters apart', 'Quiet Harbor', 'Quiet Hxrbxr'],
    ['much longer', 'Quiet Harbor', 'Quiet Harbor Keeper'],
    ['transposed in the middle and replaced', 'Quiet Harbor', 'Qiuet Harbor'],
    ['unrelated', 'Quiet Harbor', 'Morning Field'],
  ])('does not match %s', (_label, a, b) => {
    expect(isNearDuplicateName(a, b)).toBe(false);
  });

  it('requires an exact match for short names', () => {
    expect(isNearDuplicateName('Ana', 'Ann')).toBe(false);
    expect(isNearDuplicateName('Ana', 'ANA')).toBe(true);
  });

  it('never matches a name with nothing left to compare', () => {
    expect(isNearDuplicateName('!!!', '???')).toBe(false);
    expect(isNearDuplicateName('!!!', 'Quiet')).toBe(false);
  });
});
