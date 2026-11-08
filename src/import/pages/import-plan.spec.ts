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

const SLUGS = new Map([['SampleDocKey0000000000-1a', 'quill']]);

describe('pagesKey', () => {
  it.each([
    ['https://www.icloud.com/pages/SampleKey-1a#Quill', 'SampleKey-1a'],
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
        text: 'See Quill and the [ORG] page, or Elsewhere.',
        links: [
          {
            text: 'Quill',
            start: 4,
            url: 'https://www.icloud.com/pages/SampleDocKey0000000000-1a#Quill',
          },
          {
            text: 'Elsewhere',
            start: 33,
            url: 'https://www.icloud.com/pages/OTHER',
          },
          { text: 'Not in text', start: 0, url: 'https://example.test/a_(b)' },
          { text: '', start: 0, url: 'https://example.test/empty' },
        ],
      }),
      SLUGS,
      unmapped,
    );

    expect(text).toBe(
      'See [Quill](/quill) and the \\[ORG\\] page, or [Elsewhere](https://www.icloud.com/pages/OTHER). [Not in text](https://example.test/a_(b%29)',
    );
    expect(unmapped).toEqual(['https://www.icloud.com/pages/OTHER']);
  });
});

describe('paragraphMarkdown link positions', () => {
  const links = (
    text: string,
    list: { text: string; url: string; start: number }[],
  ) => paragraphMarkdown(paragraph(0, { text, links: list }), new Map(), []);

  it('writes two links with the same label where each one really is', () => {
    expect(
      links('see here and here', [
        { text: 'here', url: 'https://a.example/1', start: 4 },
        { text: 'here', url: 'https://b.example/2', start: 13 },
      ]),
    ).toBe('see [here](https://a.example/1) and [here](https://b.example/2)');
  });

  it('links the right occurrence when the label is also plain text', () => {
    expect(
      links('here is text, go here', [
        { text: 'here', url: 'https://a.example/1', start: 17 },
      ]),
    ).toBe('here is text, go [here](https://a.example/1)');
  });

  it('accounts for leading spaces and out-of-order links', () => {
    expect(
      links('  one two', [
        { text: 'two', url: 'https://b.example/2', start: 6 },
        { text: 'one', url: 'https://a.example/1', start: 2 },
      ]),
    ).toBe('[one](https://a.example/1) [two](https://b.example/2)');
  });

  it('never nests overlapping links: the later one goes at the end', () => {
    expect(
      links('outer inner', [
        { text: 'outer inner', url: 'https://a.example/1', start: 0 },
        { text: 'inner', url: 'https://b.example/2', start: 6 },
      ]),
    ).toBe('[outer inner](https://a.example/1) [inner](https://b.example/2)');
  });

  it('keeps square brackets in the text escaped around links', () => {
    expect(
      links('[a] see [b]', [
        { text: 'see', url: 'https://a.example/1', start: 4 },
      ]),
    ).toBe('\\[a\\] [see](https://a.example/1) \\[b\\]');
  });

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,x',
    'vbscript:x',
    'file:///etc/passwd',
    '#bookmark',
    '//evil.example/x',
    'hhttps://example.test/x',
  ])('drops the address %s, keeping the words, and reports it', (url) => {
    const unsafe: string[] = [];
    expect(
      paragraphMarkdown(
        paragraph(0, {
          text: 'click me',
          links: [{ text: 'click', url, start: 0 }],
        }),
        new Map(),
        [],
        unsafe,
      ),
    ).toBe('click me');
    expect(unsafe).toEqual([url]);
  });

  it.each(['https://a.example', 'HTTP://a.example', 'mailto:a@example.test'])(
    'keeps %s',
    (url) => {
      const unsafe: string[] = [];
      expect(
        paragraphMarkdown(
          paragraph(0, { text: 'x', links: [{ text: 'x', url, start: 0 }] }),
          new Map(),
          [],
          unsafe,
        ),
      ).toBe(`[x](${url})`);
      expect(unsafe).toEqual([]);
    },
  );

  it('reports mistyped and plain-text Pages links, mapped ones excepted', () => {
    const unmapped: string[] = [];
    paragraphMarkdown(
      paragraph(0, {
        text: 'Read https://www.icloud.com/pages/plainText, or broken and mapped',
        links: [
          {
            text: 'broken',
            url: 'hhttps://www.icloud.com/pages/typo',
            start: 47,
          },
          {
            text: 'mapped',
            url: 'https://www.icloud.com/pages/SampleDocKey0000000000-1a',
            start: 58,
          },
        ],
      }),
      SLUGS,
      unmapped,
    );
    expect(unmapped).toEqual([
      'https://www.icloud.com/pages/plainText',
      'hhttps://www.icloud.com/pages/typo',
    ]);
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
        text: 'A plain statement.',
        numbering: { numId: '1', level: 0, label: 'I.' },
      }),
      paragraph(5, { text: 'A. Typed sub-point' }),
      paragraph(6, { text: 'A vision' }),
    ],
    comments: [
      {
        id: '1',
        author: 'Bram ORG',
        date: '2026-07-26T13:19:54Z',
        text: 'Double letter',
        anchorText: 'A plain statement.',
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
        author: 'Odo',
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
    slug: 'bram',
    displayName: 'Bram',
    pagesUrl: 'https://www.icloud.com/pages/T',
    visibility: 'public',
    sections: [
      { section: 'bio', paragraphs: [1, 2, 3] },
      { section: 'other', heading: 'Reflections [1]', paragraphs: [6] },
    ],
    tabs: [
      { title: 'I. A plain statement.', group: 'Theology', paragraphs: [4, 5] },
    ],
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
      slug: 'bram',
      displayName: 'Bram',
      pagesUrl: 'https://www.icloud.com/pages/T',
      visibility: 'public',
      anonymous: false,
      tabs: [
        {
          tabId: 'tab_7',
          title: 'I. A plain statement.',
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
          text: 'Reflections \\[1\\]',
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
          text: 'A plain statement.',
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
          anchorText: 'A plain statement.',
          legacyAuthorName: 'Bram ORG',
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
          legacyAuthorName: 'Odo',
          body: 'Orphan reply',
          placement: { commentId: '3', paragraph: 1 },
        },
      ],
      images: [
        { path: 'Data/p.jpeg', role: 'picture' },
        { path: 'Data/g.jpeg', role: 'gallery' },
      ],
      unmappedPagesLinks: [],
      unsafeLinks: [],
    });
  });

  describe('pictures inside paragraphs', () => {
    const planOf = (spec: Partial<DocxParagraph> & { text: string }) => {
      const single: DocxDocument = {
        ...doc,
        paragraphs: [paragraph(0, spec)],
        comments: [
          {
            id: '1',
            author: 'A',
            text: 'c',
            anchorText: 'x',
            paragraphIndices: [0],
            anchored: true,
          },
        ],
      };
      const plan = buildImportPlan(
        {
          ...proposal,
          sections: [{ section: 'bio', paragraphs: [0] }],
          tabs: [],
          images: { gallery: [] },
        },
        single,
        [{ commentId: '1', paragraph: 0 }],
        SLUGS,
        sequentialIds(),
      );
      return plan;
    };

    it('emits a picture after the text it follows', () => {
      const plan = planOf({ text: 'Words.', images: ['word/media/a.png'] });
      expect(plan.blocks.map((b) => [b.kind, b.order, b.text])).toEqual([
        ['paragraph', 0, 'Words.'],
        ['image', 1, 'word/media/a.png'],
      ]);
    });

    it('emits a picture that comes first before the text, in order', () => {
      const plan = planOf({
        text: 'Words.',
        images: ['word/media/a.png', 'word/media/b.png'],
        leadingImages: 1,
      });
      expect(plan.blocks.map((b) => [b.kind, b.order, b.text])).toEqual([
        ['image', 0, 'word/media/a.png'],
        ['paragraph', 1, 'Words.'],
        ['image', 2, 'word/media/b.png'],
      ]);
      // A comment on the paragraph points at its words, not the picture.
      expect(plan.comments[0].anchorBlockId).toBe(plan.blocks[1].blockId);
    });

    it('treats a picture in an empty heading as a picture', () => {
      const plan = planOf({
        text: '',
        headingLevel: 3,
        images: ['word/media/a.png'],
      });
      expect(plan.blocks.map((b) => [b.kind, b.text])).toEqual([
        ['image', 'word/media/a.png'],
      ]);
    });

    it('keeps the picture of a heading with text', () => {
      const plan = planOf({
        text: 'Heading',
        headingLevel: 3,
        images: ['word/media/a.png'],
      });
      expect(plan.blocks.map((b) => b.kind)).toEqual(['heading', 'image']);
    });
  });

  it('clears the anchor text of a comment on the Legal section, and only that', () => {
    const legal: DocxDocument = {
      ...doc,
      paragraphs: [
        paragraph(0, { text: 'kept' }),
        paragraph(1, { text: 'legal' }),
      ],
      comments: [
        {
          id: '1',
          author: 'A',
          text: 'c',
          anchorText: 'kept\nlegal',
          paragraphIndices: [0, 1],
          anchored: true,
        },
        {
          id: '2',
          author: 'A',
          text: 'c',
          anchorText: 'kept',
          paragraphIndices: [0],
          anchored: true,
        },
      ],
    };
    const plan = buildImportPlan(
      {
        ...proposal,
        sections: [{ section: 'bio', paragraphs: [0] }],
        tabs: [],
        dropped: [{ paragraphs: [1], reason: 'Legal section: not migrated' }],
        images: { gallery: [] },
      },
      legal,
      [{ commentId: '1', paragraph: 0 }],
      SLUGS,
      sequentialIds(),
    );
    expect(plan.comments[0].anchorText).toBeUndefined();
    expect(plan.comments[1].anchorText).toBe('kept');
  });

  it('reads a comment date with no timezone as UTC, and an invalid one as absent', () => {
    const dated: DocxDocument = {
      ...doc,
      comments: [
        { ...doc.comments[0], date: '2026-07-26T13:19:54' },
        { ...doc.comments[0], id: '2', date: 'garbage' },
        { ...doc.comments[0], id: '3', date: undefined },
      ],
    };
    const plan = buildImportPlan(proposal, dated, [], SLUGS, sequentialIds());
    expect(plan.comments.map((c) => c.legacyCreatedAt)).toEqual([
      new Date('2026-07-26T13:19:54Z'),
      undefined,
      undefined,
    ]);
  });

  it('carries a nickname profile as anonymous (plan §2b)', () => {
    const plan = buildImportPlan(
      { ...proposal, anonymous: true },
      doc,
      [],
      SLUGS,
      sequentialIds(),
    );
    expect(plan.anonymous).toBe(true);
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
