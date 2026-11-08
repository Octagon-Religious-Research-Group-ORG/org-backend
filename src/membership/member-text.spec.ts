import {
  hasVisibleText,
  isNearDuplicateName,
  nameSkeleton,
} from './member-text';

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
