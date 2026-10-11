import { Types } from 'mongoose';
import {
  executeImport,
  IMPORTER_VERSION,
  type ImportStore,
} from './execute-import';
import type { ImportPlan } from './import-plan';
import type { ProcessedImage } from './image';

function memoryStore(taken = false) {
  const calls: [string, unknown][] = [];
  let images = 0;
  const record =
    (name: string) =>
    (row: unknown): Promise<void> => {
      calls.push([name, row]);
      return Promise.resolve();
    };
  const store: ImportStore = {
    profileExists: () => Promise.resolve(taken),
    createTab: record('tab'),
    createBlock: record('block'),
    appendVersion: record('version'),
    createComment: record('comment'),
    storeImage: (image, metadata) => {
      calls.push(['image', { ...metadata, bytes: image.data.length }]);
      return Promise.resolve(`img${++images}`);
    },
    createImportRecord: record('record'),
    createProfile: record('profile'),
  };
  return { store, calls };
}

const processed: ProcessedImage = {
  data: Buffer.from('webp'),
  width: 1,
  height: 1,
  contentType: 'image/webp',
};
const processImage = jest.fn(() => Promise.resolve(processed));

const plan: ImportPlan = {
  slug: 'tripp',
  displayName: 'Tripp',
  pagesUrl: 'https://www.icloud.com/pages/T',
  visibility: 'public',
  tabs: [
    { tabId: 'tab_1', title: 'I. God', group: 'Theology', order: 0 },
    { tabId: 'tab_2', title: 'II. Soul', order: 1 },
  ],
  blocks: [
    {
      blockId: 'blk_1',
      section: 'bio',
      kind: 'paragraph',
      label: '',
      order: 0,
      text: 'Bio',
      paragraph: 1,
    },
    {
      blockId: 'blk_2',
      section: 'bio',
      kind: 'image',
      label: '',
      order: 1,
      text: 'word/media/a.png',
      paragraph: 2,
    },
    {
      blockId: 'blk_3',
      section: 'bio',
      kind: 'image',
      label: '',
      order: 2,
      text: 'word/media/a.png',
      paragraph: 3,
    },
    {
      blockId: 'blk_4',
      section: 'beliefs',
      kind: 'outline-item',
      label: 'I.',
      order: 0,
      tabId: 'tab_1',
      text: 'God',
      paragraph: 4,
    },
  ],
  comments: [
    {
      commentId: 'cmt_1',
      tabId: 'tab_1',
      anchorBlockId: 'blk_4',
      anchorText: 'x'.repeat(20_001),
      legacyAuthorName: 'Tripp ORG',
      legacyCreatedAt: new Date('2026-07-26T13:19:54Z'),
      body: 'Double letter',
      placement: { commentId: '1', tab: 0, paragraph: 4 },
    },
    {
      commentId: 'cmt_2',
      parentCommentId: 'cmt_1',
      legacyAuthorName: 'Emily',
      body: 'I agree',
      placement: { commentId: '2', unplaced: 'not-anchored' },
    },
  ],
  images: [
    { path: 'Data/p.jpeg', role: 'picture' },
    { path: 'Data/g.jpeg', role: 'gallery' },
  ],
  unmappedPagesLinks: [],
};

const files = new Map<string, Uint8Array>([
  ['Data/p.jpeg', new Uint8Array([1])],
  ['Data/g.jpeg', new Uint8Array([2])],
  ['word/media/a.png', new Uint8Array([3])],
]);

const inputs = {
  files,
  sources: [
    {
      kind: 'docx' as const,
      fileName: 't.docx',
      bytes: 1,
      sha256: 'a'.repeat(64),
    },
  ],
  extractedText: 'full text',
  report: { status: 'ok' },
  now: new Date('2026-10-11T12:00:00Z'),
};

describe('executeImport', () => {
  beforeEach(() => processImage.mockClear());

  it('writes everything, in an order that leaves the profile row for last', async () => {
    const { store, calls } = memoryStore();

    const result = await executeImport(plan, inputs, store, processImage);

    expect(calls.map(([name]) => name)).toEqual([
      'tab',
      'tab',
      'block',
      'version',
      'image',
      'block',
      'version',
      'block',
      'version',
      'block',
      'version',
      'comment',
      'comment',
      'image',
      'image',
      'record',
      'profile',
    ]);
    const rows = Object.fromEntries(
      calls.map(([name], at) => [`${name}${at}`, calls[at][1]]),
    ) as Record<string, Record<string, unknown>>;
    const profileId = rows.profile16._id as Types.ObjectId;

    expect(rows.tab0).toEqual({
      profileId,
      tabId: 'tab_1',
      title: 'I. God',
      group: 'Theology',
      order: 0,
      reviewStatus: 'imported-review',
    });
    expect(rows.tab1).not.toHaveProperty('group');
    expect(rows.block2).toEqual({
      profileId,
      blockId: 'blk_1',
      section: 'bio',
      kind: 'paragraph',
      label: '',
      order: 0,
    });
    expect(rows.version3).toEqual({
      blockId: 'blk_1',
      text: 'Bio',
      authorUserId: 'system:import',
    });
    // The same inline picture used twice is stored once.
    expect(rows.version6).toEqual(
      expect.objectContaining({ blockId: 'blk_2', text: 'image:img1' }),
    );
    expect(rows.version8).toEqual(
      expect.objectContaining({ blockId: 'blk_3', text: 'image:img1' }),
    );
    expect(rows.block9).toEqual(expect.objectContaining({ tabId: 'tab_1' }));
    expect(rows.comment11).toEqual({
      commentId: 'cmt_1',
      profileId,
      tabId: 'tab_1',
      anchorBlockId: 'blk_4',
      anchorText: `${'x'.repeat(19_999)}…`,
      legacyAuthorName: 'Tripp ORG',
      legacyCreatedAt: new Date('2026-07-26T13:19:54Z'),
      body: 'Double letter',
      source: 'migrated',
    });
    expect(rows.comment12).toEqual({
      commentId: 'cmt_2',
      profileId,
      parentCommentId: 'cmt_1',
      legacyAuthorName: 'Emily',
      body: 'I agree',
      source: 'migrated',
    });
    expect(rows.image13).toEqual({
      profileSlug: 'tripp',
      source: 'Data/p.jpeg',
      role: 'picture',
      bytes: 4,
    });
    expect(rows.record15).toEqual({
      profileId,
      slug: 'tripp',
      pagesUrl: 'https://www.icloud.com/pages/T',
      sources: inputs.sources,
      extractedText: 'full text',
      report: { status: 'ok', truncatedAnchors: 1 },
      importerVersion: IMPORTER_VERSION,
      importedAt: inputs.now,
    });
    expect(rows.profile16).toEqual({
      _id: profileId,
      slug: 'tripp',
      displayName: 'Tripp',
      imageIds: ['img2', 'img3'],
      visibility: 'public',
      source: 'migrated',
      legacy: {
        pagesUrl: 'https://www.icloud.com/pages/T',
        importedAt: inputs.now,
      },
    });
    expect(result).toEqual({
      profileId: profileId.toHexString(),
      tabs: 2,
      blocks: 4,
      comments: 2,
      imageIds: ['img2', 'img3'],
      truncatedAnchors: 1,
    });
    expect(processImage).toHaveBeenCalledTimes(3);
  });

  it('defaults the import time to now', async () => {
    const { store, calls } = memoryStore();
    const before = Date.now();

    await executeImport(
      { ...plan, images: [], blocks: [], comments: [], tabs: [] },
      { ...inputs, now: undefined },
      store,
      processImage,
    );

    const profile = calls.at(-1)![1] as { legacy: { importedAt: Date } };
    expect(profile.legacy.importedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('refuses a taken address before writing anything', async () => {
    const { store, calls } = memoryStore(true);

    await expect(
      executeImport(plan, inputs, store, processImage),
    ).rejects.toThrow('A profile with the address "tripp" already exists.');
    expect(calls).toEqual([]);
  });

  it.each([
    [
      'a profile image',
      {
        ...plan,
        images: [{ path: 'Data/gone.jpeg', role: 'picture' as const }],
      },
      'Data/gone.jpeg',
    ],
    [
      'an inline image',
      {
        ...plan,
        images: [],
        blocks: [{ ...plan.blocks[1], text: 'word/media/gone.png' }],
      },
      'word/media/gone.png',
    ],
  ])(
    'refuses a missing %s before writing anything',
    async (_name, broken, path) => {
      const { store, calls } = memoryStore();

      await expect(
        executeImport(broken, inputs, store, processImage),
      ).rejects.toThrow(`Image ${path} is not among the source files.`);
      expect(calls).toEqual([]);
    },
  );

  it('never writes the profile when an earlier write fails', async () => {
    const { store, calls } = memoryStore();
    store.createComment = () => Promise.reject(new Error('write failed'));

    await expect(
      executeImport(plan, inputs, store, processImage),
    ).rejects.toThrow('write failed');
    expect(calls.some(([name]) => name === 'profile')).toBe(false);
  });
});
