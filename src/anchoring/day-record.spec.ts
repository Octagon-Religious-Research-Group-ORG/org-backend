import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import {
  DAY_RECORD_SCHEME,
  dayRecordHash,
  formatDayRecord,
  leafSetHash,
  matchesAnchor,
  matchesHead,
  parseDayRecord,
  recordOfAnchor,
} from './day-record';
import { MERKLE_SCHEME } from './merkle';
import { logLeafHash } from './tlog';

const AT = new Date('2026-11-14T03:05:00.000Z');
const ROOT = 'a'.repeat(64);
const ID_A = new Types.ObjectId('650000000000000000000001');
const ID_B = new Types.ObjectId('650000000000000000000002');
const LEAVES = [
  {
    kind: 'block' as const,
    versionId: ID_A,
    versionHash: '1'.repeat(64),
    leaf: 'b'.repeat(64),
  },
  {
    kind: 'comment' as const,
    versionId: ID_B,
    versionHash: '2'.repeat(64),
    leaf: 'c'.repeat(64),
  },
];
const SET = leafSetHash(LEAVES);
const built = {
  _id: '2026-11-14',
  status: 'built' as const,
  scheme: MERKLE_SCHEME,
  merkleRoot: ROOT,
  leafCount: 2,
  leaves: LEAVES,
};

describe('day-record', () => {
  it('writes the canonical v2 record of a built day: hashes and counts only', () => {
    const text = formatDayRecord({
      day: '2026-11-14',
      tree: MERKLE_SCHEME,
      root: ROOT,
      leaves: 2,
      leafset: SET,
      appended: AT,
    });
    expect(text).toBe(
      [
        DAY_RECORD_SCHEME,
        'day 2026-11-14',
        `tree ${MERKLE_SCHEME}`,
        `root ${ROOT}`,
        'leaves 2',
        `leafset ${SET}`,
        'appended 2026-11-14T03:05:00.000Z',
        '',
      ].join('\n'),
    );
    expect(DAY_RECORD_SCHEME).toBe('org-anchor-day-v2');
    expect(dayRecordHash(text).equals(logLeafHash(Buffer.from(text)))).toBe(
      true,
    );
    expect(parseDayRecord(text)).toEqual({
      day: '2026-11-14',
      tree: MERKLE_SCHEME,
      root: ROOT,
      leaves: 2,
      leafset: SET,
      appended: AT,
    });
  });

  it('the leaf set covers kind, version id, version hash and leaf, in any order', () => {
    const expected = createHash('sha256')
      .update(
        [
          `block ${String(ID_A)} ${'1'.repeat(64)} ${'b'.repeat(64)}\n`,
          `comment ${String(ID_B)} ${'2'.repeat(64)} ${'c'.repeat(64)}\n`,
        ].join(''),
      )
      .digest('hex');
    expect(SET).toBe(expected);
    expect(leafSetHash([...LEAVES].reverse())).toBe(SET);
    for (const change of [
      { versionId: new Types.ObjectId() },
      { kind: 'comment' as const },
      { versionHash: '3'.repeat(64) },
      { leaf: 'd'.repeat(64) },
    ]) {
      expect(leafSetHash([{ ...LEAVES[0], ...change }, LEAVES[1]])).not.toBe(
        SET,
      );
    }
  });

  it('records an empty day as having no tree and no leaf set', () => {
    const fields = recordOfAnchor({ _id: '2026-11-15', status: 'empty' }, AT);
    expect(fields).toEqual({
      day: '2026-11-15',
      tree: 'none',
      root: 'none',
      leaves: 0,
      leafset: 'none',
      appended: AT,
    });
    expect(parseDayRecord(formatDayRecord(fields!))).toEqual(fields);
  });

  it('records only finished anchors whose root, count and leaves are stored', () => {
    expect(recordOfAnchor(built, AT)).toMatchObject({
      root: ROOT,
      leaves: 2,
      leafset: SET,
    });
    for (const broken of [
      { status: 'building' as const },
      { merkleRoot: undefined },
      { leafCount: undefined },
      { scheme: undefined },
      { _id: '14/11/2026' },
      { leaves: undefined },
      { leaves: LEAVES.slice(1) },
    ]) {
      expect(recordOfAnchor({ ...built, ...broken }, AT)).toBeUndefined();
    }
  });

  it('matches an anchor on day, tree, root, count and leaf set, never on the append time', () => {
    const fields = recordOfAnchor(built, AT)!;
    expect(matchesAnchor(fields, built)).toBe(true);
    expect(matchesAnchor({ ...fields, appended: new Date(0) }, built)).toBe(
      true,
    );
    for (const change of [
      { merkleRoot: 'b'.repeat(64) },
      { leafCount: 3 },
      { status: 'empty' as const },
      { _id: '2026-11-13' },
      // A leaf's version id rewritten behind the same root (review 1, L3).
      {
        leaves: [{ ...LEAVES[0], versionId: new Types.ObjectId() }, LEAVES[1]],
      },
    ]) {
      expect(matchesAnchor(fields, { ...built, ...change })).toBe(false);
    }
  });

  it('refuses anything that is not exactly a record', () => {
    const good = formatDayRecord({
      day: '2026-11-14',
      tree: MERKLE_SCHEME,
      root: ROOT,
      leaves: 12,
      leafset: SET,
      appended: AT,
    });
    for (const text of [
      '',
      good.slice(0, -1),
      good.replace('leaves 12', 'leaves 012'),
      good.replace('leaves 12', 'leaves -1'),
      good.replace('day 2026-11-14', 'day 2026-13-40'),
      good.replace(`root ${ROOT}`, 'root ABC'),
      good.replace(DAY_RECORD_SCHEME, 'org-anchor-day-v1'),
      good.replace('.000Z', 'Z'),
      good.replace('2026-11-14T03', '2026-11-14T33'),
      good.replace('appended 2026-11-14', 'appended 2026-02-30'),
      good.replace('day 2026-11-14', 'day 2026-02-30'),
      `${good}extra\n`,
      good.replace(`tree ${MERKLE_SCHEME}`, 'tree none'),
      good.replace(`leafset ${SET}`, 'leafset none'),
      good.replace(`leafset ${SET}\n`, ''),
      good.replace('leaves 12', 'leaves 99999999999999999'),
    ]) {
      expect(parseDayRecord(text)).toBeUndefined();
    }
  });
});

describe('review 2, L1: leaf-set lines are injective only for well-formed fields', () => {
  it('L1: an anchor whose leaf fields could shift a separator is never recorded', () => {
    for (const change of [
      { versionId: 'a b' },
      { versionHash: `${'1'.repeat(63)}\n` },
      { kind: 'block comment' },
      { leaf: 'B'.repeat(64) },
      { versionId: '' },
    ]) {
      expect(
        recordOfAnchor(
          {
            ...built,
            leaves: [{ ...LEAVES[0], ...change } as never, LEAVES[1]],
          },
          AT,
        ),
      ).toBeUndefined();
    }
    expect(recordOfAnchor(built, AT)).toBeDefined();
  });

  it('matchesHead compares day, tree, root and count, not the leaf set', () => {
    const fields = recordOfAnchor(built, AT)!;
    expect(matchesHead(fields, built)).toBe(true);
    expect(matchesHead(fields, { ...built, leaves: undefined })).toBe(true);
    expect(matchesHead(fields, { ...built, merkleRoot: 'b'.repeat(64) })).toBe(
      false,
    );
    expect(matchesHead(fields, { ...built, status: 'building' as const })).toBe(
      false,
    );
    const empty = recordOfAnchor({ _id: '2026-11-15', status: 'empty' }, AT)!;
    expect(matchesHead(empty, { _id: '2026-11-15', status: 'empty' })).toBe(
      true,
    );
    expect(matchesHead(fields, { ...built, _id: '2026-11-13' })).toBe(false);
    // A built day's record never matches an anchor relabelled empty.
    expect(
      matchesHead(
        { ...fields, day: '2026-11-15' },
        { _id: '2026-11-15', status: 'empty' },
      ),
    ).toBe(false);
  });
});
