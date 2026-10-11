import type { DocxComment, DocxDocument, DocxParagraph } from './docx-reader';
import type { PagesDataFile, PagesPackage } from './pages-reader';
import {
  checkProposal,
  contentParagraphs,
  type ProfileProposal,
  proposeStructure,
  romanValue,
} from './proposal';

type Spec = Partial<DocxParagraph> & { text: string };

function docx(specs: Spec[], comments: DocxComment[] = []): DocxDocument {
  return {
    paragraphs: specs.map((spec, index) => ({
      index,
      style: '',
      links: [],
      images: [],
      inTable: false,
      ...spec,
    })),
    comments,
    media: new Map([['word/media/image1.png', new Uint8Array(1)]]),
    warnings: [],
  };
}

const h = (text: string, headingLevel = 2): Spec => ({ text, headingLevel });
const num = (text: string, level: number): Spec => ({
  text,
  numbering: { numId: '1', level, label: level === 0 ? 'I.' : 'A.' },
});

const INPUT = {
  slug: 'tripp',
  displayName: 'Tripp',
  pagesUrl: 'https://www.icloud.com/pages/abc',
  visibility: 'public' as const,
};

function dataFile(path: string, bytes: number): PagesDataFile {
  return {
    path,
    bytes,
    sha256: '0'.repeat(64),
    image: /\.(png|jpe?g|tiff)$/.test(path),
    thumbnail: /-small-/.test(path),
    data: new Uint8Array(0),
  };
}

function pages(files: PagesDataFile[]): PagesPackage {
  return { dataFiles: files, documentText: '', authorText: '' };
}

describe('romanValue', () => {
  it.each([
    ['I', 1],
    ['iv', 4],
    ['XLII', 42],
    ['C', 100],
    ['XC', 90],
  ])('reads %s as %d', (numeral, value) => {
    expect(romanValue(numeral)).toBe(value);
  });

  it.each(['IIII', 'VX', 'IC', 'B', ''])('rejects %p', (numeral) => {
    expect(romanValue(numeral)).toBeNaN();
  });
});

describe('proposeStructure', () => {
  it('splits sections, belief tabs and categories, dropping title and Legal', () => {
    const doc = docx([
      { text: 'Tripp', headingLevel: 0 },
      { text: '', images: ['word/media/image1.png'] },
      { text: '   ' },
      h('Bio'),
      { text: 'I was born…' },
      h('A memory', 3),
      { text: 'More bio' },
      h('Beliefs'),
      { text: 'Preface to my beliefs' },
      num('God exists.', 0),
      num('Detail', 1),
      h('Theology', 3),
      h('', 3),
      { text: 'Intro to theology' },
      num('Grace\nsecond line', 0),
      h('Theophanies'),
      { text: 'A vision' },
      h('Contact Info'),
      { text: 'tripp@example.test' },
      h('Legal'),
      { text: 'I certify…' },
    ]);
    const proposal = proposeStructure(
      INPUT,
      doc,
      pages([
        dataFile('Data/pasted-image-24.tiff', 900),
        dataFile('Data/IMG_4970-55.jpeg', 500),
        dataFile('Data/pasted-movie-32.png', 2000),
        dataFile('Data/IMG_4970-small-56.jpeg', 50),
        dataFile('Data/notes.plist', 9999),
      ]),
    );

    expect(proposal).toEqual({
      version: 1,
      ...INPUT,
      sections: [
        { section: 'bio', paragraphs: [4, 5, 6] },
        { section: 'other', heading: 'Theophanies', paragraphs: [16] },
        { section: 'contact', paragraphs: [18] },
      ],
      tabs: [
        { title: 'Beliefs (introduction)', paragraphs: [8] },
        { title: 'I. God exists.', paragraphs: [9, 10] },
        {
          title: 'Theology (introduction)',
          group: 'Theology',
          paragraphs: [13],
        },
        { title: 'I. Grace', group: 'Theology', paragraphs: [14] },
      ],
      structure: [3, 7, 11, 15, 17, 19],
      dropped: [
        {
          paragraphs: [0, 1],
          reason: 'Before the first section: title and navigation',
        },
        {
          paragraphs: [20],
          reason: 'Legal section: not migrated (Tripp, plan §2b)',
        },
      ],
      images: {
        picture: 'Data/pasted-image-24.tiff',
        gallery: ['Data/IMG_4970-55.jpeg'],
      },
    });
    expect(checkProposal(proposal, doc).errors).toEqual([
      'Image Data/pasted-image-24.tiff is not in the files.',
      'Image Data/IMG_4970-55.jpeg is not in the files.',
    ]);
  });

  it('starts a belief at a typed label only when it is next in sequence', () => {
    const proposal = proposeStructure(
      INPUT,
      docx([
        h('Beliefs'),
        num('No god offered by any religion is the true God.', 0),
        num('And yet I do believe.', 0),
        { text: 'III. The evidence.' },
        { text: 'A. First point.' },
        { text: 'C. The simulation.' },
        {
          text: 'IV. My conclusion, which is a very long sentence that goes on well past the eighty character limit for titles.',
        },
        { text: 'VI. Skipped five, so not a new belief.' },
        { text: 'IIII. Not a numeral.' },
        { text: 'I. A restart is allowed.' },
        { text: 'Belief 2: also typed.' },
      ]),
    );

    expect(proposal.tabs.map((tab) => [tab.title, tab.paragraphs])).toEqual([
      ['I. No god offered by any religion is the true God.', [1]],
      ['I. And yet I do believe.', [2]],
      ['III. The evidence.', [3, 4, 5]],
      [expect.stringMatching(/^IV. My conclusion.*…$/), [6, 7, 8]],
      ['I. A restart is allowed.', [9]],
      ['Belief 2: also typed.', [10]],
    ]);
    expect(proposal.tabs[3].title.length).toBeLessThanOrEqual(80);
    expect(proposal.tabs[3].title.length).toBeGreaterThan(75);
    expect(proposal.images).toEqual({ gallery: [] });
  });

  it('treats a same-level unknown heading as a new section, a deeper one as content', () => {
    const proposal = proposeStructure(
      INPUT,
      docx([
        h('Intro I wrote', 2),
        h('Bio', 2),
        h('Childhood', 3),
        h('Spiritual Possibilities', 2),
        { text: 'Maybe…' },
      ]),
    );

    expect(proposal.dropped).toEqual([
      {
        paragraphs: [0],
        reason: 'Before the first section: title and navigation',
      },
    ]);
    expect(proposal.sections).toEqual([
      { section: 'bio', paragraphs: [2] },
      {
        section: 'other',
        heading: 'Spiritual Possibilities',
        paragraphs: [4],
      },
    ]);
  });

  it('counts only paragraphs with text or images as content', () => {
    expect(
      contentParagraphs(
        docx([{ text: ' ' }, { text: 'x' }, { text: '', images: ['i'] }]),
      ).map((p) => p.index),
    ).toEqual([1, 2]);
  });
});

describe('checkProposal', () => {
  const comment = (
    id: string,
    paragraphIndices: number[],
    anchored = true,
  ): DocxComment => ({
    id,
    author: 'A',
    text: 'c',
    anchorText: 'x',
    paragraphIndices,
    anchored,
  });

  const doc = docx(
    [
      h('Bio'),
      { text: 'bio' },
      h('Beliefs'),
      num('one', 0),
      num('two', 0),
      h('Legal'),
      { text: 'legal' },
    ],
    [
      comment('1', [3]),
      comment('2', [3, 4]),
      comment('3', [1]),
      comment('4', [], false),
      comment('5', [6]),
      comment('6', [2]),
    ],
  );

  const valid = (): ProfileProposal => proposeStructure(INPUT, doc);

  it('accepts the generated proposal and places every comment', () => {
    const result = checkProposal(valid(), doc);

    expect(result.errors).toEqual([]);
    expect(result.placements).toEqual([
      { commentId: '1', tab: 0, paragraph: 3 },
      { commentId: '2', tab: 0, paragraph: 3, spansTabs: true },
      { commentId: '3', paragraph: 1 },
      { commentId: '4', unplaced: 'not-anchored' },
      { commentId: '5', unplaced: 'anchor-dropped' },
      { commentId: '6', unplaced: 'anchor-in-heading' },
    ]);
  });

  it('flags what is valid but needs a person to look', () => {
    const flaggedDoc = docx(
      [
        { text: 'Title page' },
        { text: 'nav 1' },
        { text: 'nav 2' },
        { text: 'nav 3' },
        h('Beliefs'),
        ...Array.from({ length: 17 }, (_, i) => num(`belief part ${i}`, 1)),
        h('Legal'),
        ...Array.from({ length: 5 }, () => ({ text: 'legal text' })),
      ],
      [comment('1', [5, 6]), comment('2', [], false)],
    );
    const proposal = proposeStructure(INPUT, flaggedDoc);
    // Split the long tab so one comment spans two tabs.
    proposal.tabs.push({ title: 'Second', paragraphs: [6] });
    proposal.tabs[0].paragraphs = proposal.tabs[0].paragraphs.filter(
      (index) => index !== 6,
    );

    expect(checkProposal(proposal, flaggedDoc).reviewFlags).toEqual([
      '4 paragraphs (25 characters) dropped: Before the first section: title and navigation.',
      'Tab 1 ("Beliefs (introduction)") holds 16 paragraphs.',
      '1 comment(s) could not be placed on a paragraph.',
      '1 comment(s) highlight text across tabs.',
    ]);
    expect(
      checkProposal(
        { ...proposal, tabs: [], structure: [], dropped: [] },
        flaggedDoc,
      ).reviewFlags[0],
    ).toBe('No belief tabs.');
  });

  it('ignores a dropped index that does not exist when sizing a drop', () => {
    const proposal = valid();
    proposal.dropped.push({ paragraphs: [97, 98, 99, 100, 101], reason: 'x' });
    expect(checkProposal(proposal, doc).reviewFlags).not.toContainEqual(
      expect.stringContaining('dropped: x'),
    );
  });

  it('accepts images that exist in the .pages or the .docx', () => {
    const proposal = valid();
    proposal.images = {
      picture: 'Data/p.jpeg',
      gallery: ['word/media/image1.png'],
    };
    expect(
      checkProposal(proposal, doc, pages([dataFile('Data/p.jpeg', 1)])).errors,
    ).toEqual([]);
  });

  it('refuses every way a hand edit can go wrong', () => {
    const proposal = valid();
    proposal.version = 2 as never;
    proposal.slug = 'Not A Slug';
    proposal.displayName = ' ';
    proposal.tabs[0].title = '';
    proposal.tabs[1].paragraphs = [];
    proposal.tabs.push({ title: 'x'.repeat(121), paragraphs: [1, 99] });
    proposal.dropped.push({ paragraphs: [], reason: ' ' });
    proposal.sections[0].paragraphs = [];

    expect(checkProposal(proposal, doc).errors).toEqual([
      'Unsupported proposal version 2.',
      'Slug "Not A Slug" is not a valid page address.',
      'Display name is empty.',
      'Tab 1 needs a title of 1–120 characters.',
      'Tab 2 is empty.',
      'Tab 3 needs a title of 1–120 characters.',
      'tab 3: paragraph 99 does not exist.',
      'Dropped group 2 has no reason.',
      'Paragraph 4 is not placed, dropped or a heading.',
    ]);
  });

  it('refuses a paragraph placed twice and an over-long slug', () => {
    const proposal = valid();
    proposal.slug = 'a'.repeat(81);
    proposal.tabs[1].paragraphs.push(1);

    expect(checkProposal(proposal, doc).errors).toEqual([
      `Slug "${'a'.repeat(81)}" is not a valid page address.`,
      'Paragraph 1 is placed twice: section 1 (bio) and tab 2.',
    ]);
  });
});
