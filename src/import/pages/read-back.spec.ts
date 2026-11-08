import { Types } from 'mongoose';
import type { WrittenRows } from './execute-import';
import { compareReadBack, type ReadBackSnapshot } from './read-back';

const profileId = new Types.ObjectId();
const importedAt = new Date('2026-10-11T12:00:00Z');

const written = (): WrittenRows => ({
  tabs: [{ profileId, tabId: 't1', title: 'One', order: 0 }],
  blocks: [
    { profileId, blockId: 'b1', kind: 'paragraph', label: '', order: 0 },
  ],
  versions: [
    { blockId: 'b1', text: 'A belief', authorUserId: 'system:import' },
  ],
  comments: [{ commentId: 'c1', profileId, body: 'Note', source: 'migrated' }],
  importRecord: {
    profileId,
    slug: 'sample',
    extractedText: 'A belief',
    sources: [{ kind: 'docx', fileName: 'a.docx', bytes: 1, sha256: 'a' }],
    report: { status: 'ok', nested: { a: 1, b: [1, 2] } },
    importedAt,
  },
  profile: {
    _id: profileId,
    slug: 'sample',
    displayName: 'Sample',
    imageIds: ['img1'],
    legacy: { pagesUrl: 'u', importedAt },
  },
  images: [{ id: 'img1', source: 'p.jpeg', role: 'picture', bytes: 4 }],
});

function matching(): ReadBackSnapshot {
  const w = written();
  return {
    profile: { ...w.profile, createdAt: new Date() },
    tabs: w.tabs,
    blocks: w.blocks,
    versions: w.versions,
    comments: w.comments,
    importRecords: [
      // Key order does not matter; a stored id comes back as an equal object.
      {
        report: { nested: { b: [1, 2], a: 1 }, status: 'ok' },
        ...w.importRecord,
        profileId: new Types.ObjectId(profileId.toHexString()),
      },
    ],
    images: w.images,
  };
}

describe('compareReadBack', () => {
  it('finds nothing when the database holds what was written', () => {
    expect(compareReadBack(written(), matching())).toEqual([]);
  });

  it('accepts the trimming Mongoose applies to a stored value', () => {
    const actual = matching();
    actual.tabs = [{ ...actual.tabs[0], title: 'One' }];
    const w = written();
    w.tabs[0].title = '  One  ';
    expect(compareReadBack(w, actual)).toEqual([]);
  });

  it('reports a profile row that never arrived', () => {
    expect(
      compareReadBack(written(), { ...matching(), profile: null }),
    ).toEqual([
      `profile ${profileId.toHexString()}: missing`,
      'profile: 0 found, 1 written',
    ]);
  });

  it.each([
    ['tabs', 'tab t1: title differs', { title: 'Other' }],
    ['blocks', 'block b1: order differs', { order: 9 }],
    ['versions', 'block text b1: text differs', { text: 'changed' }],
    ['comments', 'comment c1: body differs', { body: 'changed' }],
    ['images', 'image img1: bytes differs', { bytes: 3 }],
  ] as const)('reports a changed row in %s', (kind, message, change) => {
    const actual = matching();
    actual[kind] = [{ ...actual[kind][0], ...change }];
    expect(compareReadBack(written(), actual)).toEqual([message]);
  });

  it('reports a changed import record and a changed profile', () => {
    const actual = matching();
    actual.importRecords = [
      { ...actual.importRecords[0], extractedText: 'other' },
    ];
    actual.profile = { ...actual.profile!, imageIds: ['img9'] };
    expect(compareReadBack(written(), actual)).toEqual([
      `profile ${profileId.toHexString()}: imageIds differs`,
      `import record ${profileId.toHexString()}: extractedText differs`,
    ]);
  });

  it('reports a field the database lacks', () => {
    const actual = matching();
    const untitled = { ...actual.tabs[0] };
    delete untitled.title;
    actual.tabs = [untitled];
    expect(compareReadBack(written(), actual)).toEqual([
      'tab t1: title differs',
    ]);
  });

  it('reports rows that should not be there', () => {
    const actual = matching();
    actual.tabs = [...actual.tabs, { tabId: 't2', title: 'Extra' }];
    expect(compareReadBack(written(), actual)).toEqual([
      'tab: 2 found, 1 written',
    ]);
  });

  it('reports a missing picture', () => {
    expect(compareReadBack(written(), { ...matching(), images: [] })).toEqual([
      'image img1: missing',
      'image: 0 found, 1 written',
    ]);
  });
});
