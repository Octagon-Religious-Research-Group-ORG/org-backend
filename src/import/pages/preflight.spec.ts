import {
  MAX_DOCUMENT_BYTES,
  preflightImport,
  REPORT_ALLOWANCE_BYTES,
} from './preflight';
import type { ImportPlan } from './import-plan';
import type { ProcessedImage } from './image';

const processed: ProcessedImage = {
  data: Buffer.from('webp'),
  width: 1,
  height: 1,
  contentType: 'image/webp',
};
const convert = () => Promise.resolve(processed);

const plan = (overrides: Partial<ImportPlan> = {}): ImportPlan => ({
  slug: 'sample',
  displayName: 'Sample',
  pagesUrl: 'https://www.icloud.com/pages/T',
  visibility: 'public',
  anonymous: false,
  tabs: [{ tabId: 'tab_1', title: 'One', order: 0 }],
  blocks: [
    {
      blockId: 'blk_1',
      section: 'beliefs',
      kind: 'paragraph',
      label: '',
      order: 0,
      tabId: 'tab_1',
      text: 'A belief',
      paragraph: 3,
    },
  ],
  comments: [
    {
      commentId: 'cmt_1',
      legacyAuthorName: 'Ann',
      body: 'A comment',
      placement: { commentId: '1', unplaced: 'not-anchored' },
    },
  ],
  images: [],
  unmappedPagesLinks: [],
  unsafeLinks: [],
  ...overrides,
});

const inputs = {
  files: new Map<string, Uint8Array>([['Data/p.jpeg', new Uint8Array([1])]]),
  sources: [
    {
      kind: 'docx' as const,
      fileName: 'a.docx',
      bytes: 1,
      sha256: 'a'.repeat(64),
    },
  ],
  extractedText: 'all the text',
};

const block = plan().blocks[0];

describe('preflightImport', () => {
  it('accepts a plan the real schemas accept', async () => {
    await expect(preflightImport(plan(), inputs, convert)).resolves.toEqual([]);
  });

  it.each<[string, Partial<ImportPlan>, string]>([
    [
      'a paragraph over the length limit',
      { blocks: [{ ...block, text: 'y'.repeat(20_001) }] },
      'Text of paragraph 3: text: maxlength',
    ],
    [
      'an empty text block',
      { blocks: [{ ...block, text: '' }] },
      'Text of paragraph 3: text: required',
    ],
    [
      'a label over the limit',
      { blocks: [{ ...block, label: 'x'.repeat(21) }] },
      'Block for paragraph 3: label: maxlength',
    ],
    [
      'a tab block outside the beliefs section',
      { blocks: [{ ...block, section: 'bio' }] },
      'Block for paragraph 3: tabId: Only blocks in the beliefs section belong to a tab.',
    ],
    [
      'a tab title over the limit',
      { tabs: [{ tabId: 'tab_1', title: 'x'.repeat(121), order: 0 }] },
      'Tab 1: title: maxlength',
    ],
    [
      'a group over the limit',
      {
        tabs: [{ tabId: 't', title: 'x', group: 'g'.repeat(121), order: 0 }],
      },
      'Tab 1: group: maxlength',
    ],
    [
      'an empty comment',
      { comments: [{ ...plan().comments[0], body: '' }] },
      'Comment 1: body: required',
    ],
    [
      'a comment over the limit',
      { comments: [{ ...plan().comments[0], body: 'z'.repeat(10_001) }] },
      'Comment 1: body: maxlength',
    ],
    ['a one-letter address', { slug: 'a' }, 'Profile: slug: minlength'],
  ])('rejects %s', async (_name, overrides, message) => {
    await expect(
      preflightImport(plan(overrides), inputs, convert),
    ).resolves.toEqual([message]);
  });

  it('rejects empty extracted text in the import record', async () => {
    await expect(
      preflightImport(plan(), { ...inputs, extractedText: '' }, convert),
    ).resolves.toEqual(['Import record: extractedText: required']);
  });

  it('never repeats the member text in a message', async () => {
    const errors = await preflightImport(
      plan({ blocks: [{ ...block, text: 'SECRET '.repeat(4000) }] }),
      inputs,
      convert,
    );
    expect(errors.join(' ')).not.toContain('SECRET');
  });

  it('converts every picture and reports each one that fails', async () => {
    const failing = jest.fn((bytes: Uint8Array) =>
      bytes[0] === 1
        ? Promise.reject(new Error('unsupported image format'))
        : Promise.resolve(processed),
    );
    const files = new Map<string, Uint8Array>([
      ['Data/p.jpeg', new Uint8Array([1])],
      ['word/media/a.png', new Uint8Array([2])],
    ]);
    const errors = await preflightImport(
      plan({
        images: [{ path: 'Data/p.jpeg', role: 'picture' }],
        blocks: [
          block,
          {
            ...block,
            blockId: 'blk_2',
            kind: 'image',
            text: 'word/media/a.png',
          },
          {
            ...block,
            blockId: 'blk_3',
            kind: 'image',
            text: 'word/media/a.png',
          },
        ],
      }),
      { ...inputs, files },
      failing,
    );
    expect(errors).toEqual([
      'Image Data/p.jpeg could not be converted: unsupported image format',
    ]);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('refuses a document over the 16 MB limit, and only then', async () => {
    const withText = (size: number) =>
      preflightImport(
        plan(),
        { ...inputs, extractedText: 'x'.repeat(size) },
        convert,
      );
    await expect(withText(MAX_DOCUMENT_BYTES)).resolves.toEqual([
      "Import record: larger than MongoDB's 16 MB document limit",
    ]);
    await expect(
      withText(MAX_DOCUMENT_BYTES - REPORT_ALLOWANCE_BYTES),
    ).resolves.toEqual([
      "Import record: larger than MongoDB's 16 MB document limit",
    ]);
    await expect(
      withText(MAX_DOCUMENT_BYTES - REPORT_ALLOWANCE_BYTES - 1000),
    ).resolves.toEqual([]);
  });

  it('reports a picture the plan expects and the package lacks', async () => {
    const errors = await preflightImport(
      plan({
        blocks: [{ ...block, kind: 'image', text: 'word/../media/up.png' }],
      }),
      inputs,
      convert,
    );
    expect(errors).toEqual([
      'Image word/../media/up.png is not among the source files.',
    ]);
  });
});
