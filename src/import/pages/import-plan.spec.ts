import type { DocxComment, DocxDocument, DocxParagraph } from './docx-reader';
import {
  buildImportPlan,
  type IdFactory,
  pagesKey,
  paragraphMarkdown,
  randomIds,
} from './import-plan';
import type { ProfileProposal } from './proposal';

function paragraph(
  index: number,
  spec: Partial<DocxParagraph> & { text: string },
): DocxParagraph {
  return { index, style: '', links: [], images: [], inTable: false, ...spec };
}

function sequentialIds(): IdFactory {
  let next = 0;
  return (prefix) => `${prefix}_${++next}`;
}

const SLUGS = new Map([['0080pSrnZRMtMf8XV8DAZ-7Lg', 'renan']]);

describe('pagesKey', () => {
  it.each([
    ['https://www.icloud.com/pages/0080pSrnZ-7Lg#Renan', '0080pSrnZ-7Lg'],
    [' http://icloud.com/pages/ABC_def?x=1 ', 'ABC_def'],
    ['https://example.test/pages/ABC', undefined],
  ])('reads %p', (url, key) => {
    expect(pagesKey(url)).toBe(key);
  });
});

describe('randomIds', () => {
  it('prefixes a fresh UUID', () => {
    expect(randomIds('blk')).toMatch(/^blk_[0-9a-f-]{36}$/);
    expect(randomIds('tab')).not.toBe(randomIds('tab'));
  });
});

describe('paragraphMarkdown', () => {
  it('writes links as Markdown, rewriting links between migrated profiles', () => {
    const unmapped: string[] = [];
    const text = paragraphMarkdown(
      paragraph(0, {
        text: 'See Renan and the [ORG] page, or Elsewhere.',
        links: [
          {
            text: 'Renan',
            url: 'https://www.icloud.com/pages/0080pSrnZRMtMf8XV8DAZ-7Lg#Renan',
          },
          { text: 'Elsewhere', url: 'https://www.icloud.com/pages/OTHER' },
          { text: 'Not in text', url: 'https://example.test/a_(b)' },
          { text: '', url: 'https://example.test/empty' },
        ],
      }),
      SLUGS,
      unmapped,
    );

    expect(text).toBe(
      'See [Renan](/renan) and the \\[ORG\\] page, or [Elsewhere](https://www.icloud.com/pages/OTHER). [Not in text](https://example.test/a_(b%29)',
    );
    expect(unmapped).toEqual(['https://www.icloud.com/pages/OTHER']);
  });
});

describe('buildImportPlan', () => {
  const doc: DocxDocument = {
    paragraphs: [
      paragraph(0, { text: 'Bio heading', headingLevel: 2 }),
      paragraph(1, { text: 'I grew up…' }),
      paragraph(2, {
        text: '',
        images: ['word/media/a.png', 'word/media/b.png'],
      }),
      paragraph(3, { text: 'Sub', headingLevel: 3 }),
      paragraph(4, {
        text: 'God exists.',
        numbering: { numId: '1', level: 0, label: 'I.' },
      }),
      paragraph(5, { text: 'A. Typed sub-point' }),
      paragraph(6, { text: 'A vision' }),
    ],
    comments: [
      {
        id: '1',
        author: 'Tripp ORG',
        date: '2026-07-26T13:19:54Z',
        text: 'Double letter',
        anchorText: 'God exists.',
        paragraphIndices: [4],
        anchored: true,
      },
      {
        id: '2',
        author: ' ',
        date: 'not a date',
        text: 'I agree',
        parentId: '1',
        anchorText: '',
        paragraphIndices: [],
        anchored: false,
      },
      {
        id: '3',
        author: 'Leo',
        text: 'Orphan reply',
        parentId: '99',
        anchorText: 'grew',
        paragraphIndices: [1],
        anchored: true,
      },
    ] satisfies DocxComment[],
    media: new Map(),
    warnings: [],
  };

  const proposal: ProfileProposal = {
    version: 1,
    slug: 'tripp',
    displayName: 'Tripp',
    pagesUrl: 'https://www.icloud.com/pages/T',
    visibility: 'public',
    sections: [
      { section: 'bio', paragraphs: [1, 2, 3] },
      { section: 'other', heading: 'Theophanies [1]', paragraphs: [6] },
    ],
    tabs: [{ title: 'I. God exists.', group: 'Theology', paragraphs: [4, 5] }],
    structure: [0],
    dropped: [],
    images: { picture: 'Data/p.jpeg', gallery: ['Data/g.jpeg'] },
  };

  it('plans every row with stable order, kinds, labels and comment links', () => {
    const plan = buildImportPlan(
      proposal,
      doc,
      [
        { commentId: '1', tab: 0, paragraph: 4 },
        { commentId: '3', paragraph: 1 },
      ],
      SLUGS,
      sequentialIds(),
    );

    expect(plan).toEqual({
      slug: 'tripp',
      displayName: 'Tripp',
      pagesUrl: 'https://www.icloud.com/pages/T',
      visibility: 'public',
      tabs: [
        {
          tabId: 'tab_7',
          title: 'I. God exists.',
          group: 'Theology',
          order: 0,
        },
      ],
      blocks: [
        {
          blockId: 'blk_1',
          section: 'bio',
          kind: 'paragraph',
          label: '',
          order: 0,
          text: 'I grew up…',
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
          text: 'word/media/b.png',
          paragraph: 2,
        },
        {
          blockId: 'blk_4',
          section: 'bio',
          kind: 'heading',
          label: '',
          order: 3,
          text: 'Sub',
          paragraph: 3,
        },
        {
          blockId: 'blk_5',
          section: 'other',
          kind: 'heading',
          label: '',
          order: 0,
          text: 'Theophanies \\[1\\]',
          paragraph: -1,
        },
        {
          blockId: 'blk_6',
          section: 'other',
          kind: 'paragraph',
          label: '',
          order: 1,
          text: 'A vision',
          paragraph: 6,
        },
        {
          blockId: 'blk_8',
          section: 'beliefs',
          kind: 'outline-item',
          label: 'I.',
          order: 0,
          tabId: 'tab_7',
          text: 'God exists.',
          paragraph: 4,
        },
        {
          blockId: 'blk_9',
          section: 'beliefs',
          kind: 'outline-item',
          label: 'A.',
          order: 1,
          tabId: 'tab_7',
          text: 'A. Typed sub-point',
          paragraph: 5,
        },
      ],
      comments: [
        {
          commentId: 'cmt_10',
          tabId: 'tab_7',
          anchorBlockId: 'blk_8',
          anchorText: 'God exists.',
          legacyAuthorName: 'Tripp ORG',
          legacyCreatedAt: new Date('2026-07-26T13:19:54Z'),
          body: 'Double letter',
          placement: { commentId: '1', tab: 0, paragraph: 4 },
        },
        {
          commentId: 'cmt_11',
          parentCommentId: 'cmt_10',
          legacyAuthorName: 'Unknown (Apple Pages)',
          body: 'I agree',
          placement: { commentId: '2', unplaced: 'not-anchored' },
        },
        {
          commentId: 'cmt_12',
          anchorBlockId: 'blk_1',
          anchorText: 'grew',
          legacyAuthorName: 'Leo',
          body: 'Orphan reply',
          placement: { commentId: '3', paragraph: 1 },
        },
      ],
      images: [
        { path: 'Data/p.jpeg', role: 'picture' },
        { path: 'Data/g.jpeg', role: 'gallery' },
      ],
      unmappedPagesLinks: [],
    });
  });

  it('ignores a placement paragraph that produced no block, and has default ids', () => {
    const plan = buildImportPlan(
      {
        ...proposal,
        tabs: [{ title: 'Ungrouped', paragraphs: [4, 5] }],
        images: { gallery: [] },
      },
      doc,
      [{ commentId: '1', paragraph: 0 }],
      SLUGS,
    );

    expect(plan.comments[0].anchorBlockId).toBeUndefined();
    expect(plan.images).toEqual([]);
    expect(plan.tabs[0]).not.toHaveProperty('group');
    expect(plan.blocks[0].blockId).toMatch(/^blk_/);
  });
});
