import type { DocxComment, DocxDocument, DocxParagraph } from './docx-reader';
import type { PagesDataFile, PagesPackage } from './pages-reader';
import {
  checkProposal,
  contentParagraphs,
  DROP_REVIEW_CHARACTERS,
  LEGAL_REVIEW_CHARACTERS,
  LEGAL_REVIEW_PARAGRAPHS,
  type ProfileProposal,
  proposeStructure,
  reviewProblems,
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
  slug: 'bram',
  displayName: 'Bram',
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
      { text: 'Bram', headingLevel: 0 },
      { text: '', images: ['word/media/image1.png'] },
      { text: '   ' },
      h('Bio'),
      { text: 'I was born…' },
      h('A memory', 3),
      { text: 'More bio' },
      h('Beliefs'),
      { text: 'Preface to my beliefs' },
      num('A plain statement.', 0),
      num('Detail', 1),
      h('Theology', 3),
      h('', 3),
      { text: 'Intro to theology' },
      num('Grace\nsecond line', 0),
      h('Reflections'),
      { text: 'A vision' },
      h('Contact Info'),
      { text: 'bram@example.test' },
      h('Legal'),
      { text: 'I certify…' },
    ]);
    const proposal = proposeStructure(
      INPUT,
      doc,
      pages([
        dataFile('Data/pasted-image-24.tiff', 900),
        dataFile('Data/IMG_0001-55.jpeg', 500),
        {
          ...dataFile('Data/pasted-movie-32.png', 2000),
          sha256: 'n'.repeat(64),
        },
        dataFile('Data/IMG_0001-small-56.jpeg', 50),
        dataFile('Data/notes.plist', 9999),
      ]),
      // The navigation tile is in every member's page: template art.
      { templateSha256: new Set(['n'.repeat(64)]) },
    );

    expect(proposal).toEqual({
      version: 1,
      ...INPUT,
      sections: [
        { section: 'bio', paragraphs: [4, 5, 6] },
        { section: 'other', heading: 'Reflections', paragraphs: [16] },
        { section: 'contact', paragraphs: [18] },
      ],
      tabs: [
        { title: 'Beliefs (introduction)', paragraphs: [8] },
        { title: 'I. A plain statement.', paragraphs: [9, 10] },
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
          reason: 'Legal section: not migrated (owner decision, plan §2b)',
        },
      ],
      images: {
        picture: 'Data/pasted-image-24.tiff',
        gallery: ['Data/IMG_0001-55.jpeg'],
      },
    });
    expect(checkProposal(proposal, doc).errors).toEqual([
      'Image Data/pasted-image-24.tiff is not in the files.',
      'Image Data/IMG_0001-55.jpeg is not in the files.',
    ]);
  });

  it('starts a belief at a typed label only when it is next in sequence', () => {
    const proposal = proposeStructure(
      INPUT,
      docx([
        h('Beliefs'),
        num('The first sample statement is here.', 0),
        num('A second sample statement.', 0),
        { text: 'III. The evidence.' },
        { text: 'A. First point.' },
        { text: 'C. A later point.' },
        {
          text: 'IV. My conclusion, which is a very long sentence that goes on well past the eighty character limit for titles.',
        },
        { text: 'VI. Skipped five, so not a new belief.' },
        { text: 'IIII. Not a numeral.' },
        { text: 'I. A later "I." does not restart the count.' },
        { text: 'V. Five, the next number after IV.' },
        { text: 'Belief 6: also typed.' },
      ]),
    );

    expect(proposal.tabs.map((tab) => [tab.title, tab.paragraphs])).toEqual([
      ['I. The first sample statement is here.', [1]],
      ['I. A second sample statement.', [2]],
      ['III. The evidence.', [3, 4, 5]],
      [expect.stringMatching(/^IV. My conclusion.*…$/), [6, 7, 8, 9]],
      ['V. Five, the next number after IV.', [10]],
      ['Belief 6: also typed.', [11]],
    ]);
    expect(proposal.tabs[3].title.length).toBeLessThanOrEqual(80);
    expect(proposal.tabs[3].title.length).toBeGreaterThan(75);
    expect(proposal.images).toEqual({ gallery: [] });
  });

  describe('typed numbering', () => {
    const titles = (texts: string[]) => {
      const doc = docx([h('Beliefs'), ...texts.map((text) => ({ text }))]);
      const proposal = proposeStructure(INPUT, doc);
      return {
        tabs: proposal.tabs.map((tab) => [tab.title, tab.paragraphs.length]),
        flags: checkProposal(proposal, doc).reviewFlags,
      };
    };

    it('reads "I." after "H." as the letter, keeping every belief', () => {
      const letters = 'ABCDEFGH'.split('').map((l) => `${l}. point`);
      const { tabs, flags } = titles([
        'I. One',
        ...letters,
        'I. the ninth letter',
        'J. point',
        'II. Two',
        'III. Three',
      ]);
      expect(tabs).toEqual([
        ['I. One', 11],
        ['II. Two', 1],
        ['III. Three', 1],
      ]);
      expect(flags).toEqual([]);
    });

    it('keeps "I." under "III." in the belief, does not restart, and flags it', () => {
      const { tabs, flags } = titles([
        'I. One',
        'II. Two',
        'III. Three',
        'A. a',
        'I. which letter is this',
        'IV. Four',
        'V. Five',
      ]);
      expect(tabs).toEqual([
        ['I. One', 1],
        ['II. Two', 1],
        ['III. Three', 3],
        ['IV. Four', 1],
        ['V. Five', 1],
      ]);
      expect(flags).toEqual([
        'Paragraph 5: its typed label does not follow the numbering; check whether it starts a belief.',
      ]);
    });

    it('never makes typed lower-case sub-points into tabs', () => {
      const { tabs, flags } = titles([
        'I. One',
        'A. a',
        'i. sub one',
        'ii. sub two',
        'II. Two',
      ]);
      expect(tabs).toEqual([
        ['I. One', 4],
        ['II. Two', 1],
      ]);
      expect(flags).toEqual([]);
    });

    it('flags lower-case numerals with no belief above them', () => {
      const { flags } = titles(['i. first', 'ii. second', 'vx. no numeral']);
      expect(flags).toEqual([
        'Paragraph 1: a lower-case numeral with no belief above it; check how this list was split.',
        'Paragraph 2: a lower-case numeral with no belief above it; check how this list was split.',
      ]);
    });

    it.each([
      ['after a full stop', 'I. The first statement.A. A second one follows.'],
      ['after a quote', 'I. It says "so."B. And more.'],
      ['with a Roman label', 'I. The first.II. The second runs on.'],
      ['after a line break', 'I. The first\nB. The second.'],
    ])('flags items run together %s', (_name, text) => {
      expect(titles([text]).flags).toEqual([
        'Paragraph 1: may hold several items run together; split it by hand if so.',
      ]);
    });

    it('does not flag an ordinary sentence', () => {
      expect(titles(['I. Dr. Who said a thing. Then left.']).flags).toEqual([]);
    });
  });

  describe('the Legal section', () => {
    it('keeps a Legal-prefixed category inside Beliefs, and flags it', () => {
      const doc = docx([
        h('Beliefs'),
        h('Basic', 3),
        { text: 'I. one' },
        h('Legal Rights and Liberty', 3),
        { text: 'I. a belief about liberty' },
        h('Theology', 3),
        { text: 'I. kept' },
      ]);
      const proposal = proposeStructure(INPUT, doc);

      expect(proposal.dropped).toEqual([]);
      expect(proposal.tabs.map((tab) => tab.group)).toEqual([
        'Basic',
        'Legal Rights and Liberty',
        'Theology',
      ]);
      expect(checkProposal(proposal, doc).reviewFlags).toEqual([
        'Heading at paragraph 3 starts with "Legal" but what follows is kept; confirm it is the member\'s own text and not the Legal section.',
      ]);
    });

    it.each(['Legal', ' LEGAL ', 'legal:', 'Legal :', 'Legal\u00a0'])(
      'treats a section heading written %p as the Legal section',
      (heading) => {
        const doc = docx([
          h('Beliefs'),
          { text: 'a' },
          h(heading),
          { text: 'l' },
        ]);
        const proposal = proposeStructure(INPUT, doc);
        expect(proposal.dropped.map((drop) => drop.paragraphs)).toEqual([[3]]);
        expect(checkProposal(proposal, doc).reviewFlags).toEqual([]);
      },
    );

    it('keeps a same-level "Legal Rights" section as the member wrote it', () => {
      const doc = docx([
        h('Beliefs'),
        { text: 'a' },
        h('Legal Rights'),
        { text: 'mine' },
      ]);
      const proposal = proposeStructure(INPUT, doc);
      expect(proposal.sections).toEqual([
        { section: 'other', heading: 'Legal Rights', paragraphs: [3] },
      ]);
    });

    it('does not treat "Legal" deeper than the section level as the section', () => {
      const doc = docx([
        h('Beliefs', 2),
        { text: 'a' },
        h('Legal', 3),
        { text: 'still mine' },
      ]);
      const proposal = proposeStructure(INPUT, doc);
      expect(proposal.dropped).toEqual([]);
      expect(proposal.tabs[1]).toEqual(
        expect.objectContaining({ group: 'Legal' }),
      );
      expect(checkProposal(proposal, doc).reviewFlags).toEqual([
        expect.stringContaining('starts with "Legal"'),
      ]);
    });

    it('flags a heading caught inside the Legal section', () => {
      const doc = docx([
        h('Beliefs'),
        { text: 'a' },
        h('Legal'),
        { text: 'checklist' },
        h('My other thoughts', 3),
        { text: 'not legal at all' },
      ]);
      expect(
        checkProposal(proposeStructure(INPUT, doc), doc).reviewFlags,
      ).toEqual([
        'Heading at paragraph 4 sits inside the dropped Legal section; check that it is really part of it.',
      ]);
    });

    it('reports its size and flags one over either limit', () => {
      const legal = (count: number, length: number) =>
        docx([
          h('Beliefs'),
          { text: 'I. a' },
          h('Legal'),
          ...Array.from({ length: count }, () => ({
            text: 'x'.repeat(length),
          })),
        ]);
      const run = (doc: DocxDocument) =>
        checkProposal(proposeStructure(INPUT, doc), doc);

      expect(run(legal(LEGAL_REVIEW_PARAGRAPHS, 1))).toEqual(
        expect.objectContaining({
          reviewFlags: [],
          legalDropped: { paragraphs: 30, characters: 30 },
        }),
      );
      expect(run(legal(LEGAL_REVIEW_PARAGRAPHS + 1, 1)).reviewFlags).toEqual([
        'Legal section dropped: 31 paragraphs (31 characters), more than expected; check that it holds nothing else.',
      ]);
      expect(run(legal(1, LEGAL_REVIEW_CHARACTERS)).reviewFlags).toEqual([]);
      expect(run(legal(1, LEGAL_REVIEW_CHARACTERS + 1)).reviewFlags).toEqual([
        'Legal section dropped: 1 paragraphs (5001 characters), more than expected; check that it holds nothing else.',
      ]);
    });

    it('flags paragraphs dropped as Legal that are not under a Legal heading', () => {
      const doc = docx([
        h('Beliefs'),
        { text: 'a' },
        h('Theology', 3),
        { text: 'hand-dropped' },
      ]);
      const proposal = proposeStructure(INPUT, doc);
      proposal.tabs.pop();
      proposal.dropped.push({ paragraphs: [3], reason: 'Legal, by hand' });
      expect(checkProposal(proposal, doc).reviewFlags).toEqual(
        expect.arrayContaining([
          'Paragraphs dropped as Legal do not sit under a "Legal" heading; check they belong there (paragraph 3).',
        ]),
      );
      proposal.dropped[0].paragraphs = [1];
      proposal.structure = [];
      proposal.tabs = [];
      const unheaded = docx([{ text: 'first' }, { text: 'b' }]);
      expect(
        checkProposal(
          {
            ...proposal,
            sections: [],
            dropped: [{ paragraphs: [0, 1], reason: 'Legal, by hand' }],
          },
          unheaded,
        ).reviewFlags,
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining('do not sit under a "Legal" heading'),
        ]),
      );
    });
  });

  it('flags drops outside Legal over the character limit, across groups', () => {
    const doc = (size: number) =>
      docx([
        { text: 'x'.repeat(size) },
        h('Bio'),
        { text: '---' },
        h('Beliefs'),
        { text: 'I. a' },
      ]);
    const run = (d: DocxDocument) =>
      checkProposal(proposeStructure(INPUT, d), d).reviewFlags;

    expect(run(doc(DROP_REVIEW_CHARACTERS - 3))).toEqual([]);
    expect(run(doc(DROP_REVIEW_CHARACTERS - 2))).toEqual([
      '501 characters dropped outside the Legal section.',
    ]);
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

  it('names a category item and splits its lettered sub-points into tabs', () => {
    const lettered = (text: string) => ({
      text,
      numbering: { numId: '1', level: 1, label: 'A.' },
    });
    const proposal = proposeStructure(
      INPUT,
      docx([
        h('Beliefs'),
        num('Sample category', 0),
        lettered('A first lettered point'),
        lettered('A second lettered point'),
        { text: 'continued', numbering: { numId: '1', level: 2, label: '1.' } },
      ]),
    );

    expect(proposal.tabs).toEqual([
      {
        title: 'A. A first lettered point',
        group: 'Sample category',
        paragraphs: [2],
      },
      {
        title: 'A. A second lettered point',
        group: 'Sample category',
        paragraphs: [3, 4],
      },
    ]);
    expect(proposal.structure).toEqual([0, 1]);
  });

  it('keeps a single long or sentence-like top item as the belief', () => {
    const lettered = (text: string) => ({
      text,
      numbering: { numId: '1', level: 1, label: 'A.' },
    });
    const proposal = proposeStructure(
      INPUT,
      docx([
        h('Beliefs'),
        num('A short claim.', 0),
        lettered('Point one'),
        lettered('Point two'),
      ]),
    );
    expect(proposal.tabs).toEqual([
      { title: 'I. A short claim.', paragraphs: [1, 2, 3] },
    ]);
  });

  it('makes each unlabelled belief paragraph its own tab', () => {
    const proposal = proposeStructure(
      INPUT,
      docx([h('Beliefs'), { text: 'First belief.' }, { text: 'Second.' }]),
    );
    expect(proposal.tabs).toEqual([
      { title: 'First belief.', paragraphs: [1] },
      { title: 'Second.', paragraphs: [2] },
    ]);
  });

  it('splits a combined Bio & Beliefs section: story to bio, bullets to tabs', () => {
    const proposal = proposeStructure(
      INPUT,
      docx([
        h('Bio & Beliefs', 3),
        { text: 'A sample childhood line.' },
        { text: '•A sample story from the past.' },
        { text: '---' },
        { text: 'More of my story.' },
        { text: '● Another bullet belief.' },
      ]),
    );
    expect(proposal.sections).toEqual([{ section: 'bio', paragraphs: [1, 4] }]);
    expect(proposal.tabs).toEqual([
      { title: 'A sample story from the past.', paragraphs: [2] },
      { title: 'Another bullet belief.', paragraphs: [5] },
    ]);
    expect(proposal.dropped).toEqual([
      { paragraphs: [3], reason: 'Separator lines' },
    ]);
  });

  it('drops template hints and names the onboarding template', () => {
    const doc = docx([
      { text: 'Public Membership:' },
      { text: 'I. Check out other pages.' },
      h('Bio'),
      { text: '(Your bio here)' },
      { text: 'Real bio.' },
      h('Beliefs'),
      { text: '(Add any beliefs/ideas you want…)' },
    ]);
    const proposal = proposeStructure(INPUT, doc);

    expect(proposal.dropped).toEqual([
      {
        paragraphs: [0, 1],
        reason:
          "Onboarding template copied into the page (the founder's membership instructions), not the member's own text",
      },
      {
        paragraphs: [3, 6],
        reason: 'Unfilled template placeholder (instructions in parentheses)',
      },
    ]);
    expect(proposal.sections).toEqual([{ section: 'bio', paragraphs: [4] }]);
    expect(checkProposal(proposal, doc).reviewFlags).toEqual([
      'No belief tabs.',
      '2 paragraphs (48 characters) dropped: Unfilled template placeholder (instructions in parentheses).',
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

describe('reviewProblems', () => {
  const SHA = 'a'.repeat(64);
  const proposal = (reviewed: unknown): ProfileProposal =>
    ({ reviewed }) as ProfileProposal;
  const good = { by: 'Sam', at: '2026-11-08T10:00:00Z', sourceSha256: SHA };

  it('has nothing to say about a proposal with no review, or a sound one', () => {
    expect(reviewProblems(proposal(undefined), SHA)).toEqual([]);
    expect(reviewProblems(proposal(good), SHA)).toEqual([]);
  });

  it.each([
    [
      'null',
      null,
      '"by" is empty; "at" is not a valid date; it has no "sourceSha256"',
    ],
    ['empty by', { ...good, by: '  ' }, '"by" is empty'],
    ['non-text by', { ...good, by: 3 }, '"by" is empty'],
    ['bad at', { ...good, at: 'yesterday' }, '"at" is not a valid date'],
    ['non-text at', { ...good, at: 3 }, '"at" is not a valid date'],
    ['no hash', { by: 'Sam', at: good.at }, 'it has no "sourceSha256"'],
    [
      'stale',
      { ...good, sourceSha256: 'b'.repeat(64) },
      'the .docx has changed',
    ],
  ])('voids a review with %s, saying how to fix it', (_n, reviewed, reason) => {
    const [problem] = reviewProblems(proposal(reviewed), SHA);
    expect(problem).toContain(`Review is void: ${reason}`);
    expect(problem).toContain(`"sourceSha256": "${SHA}"`);
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

  it('refuses a belief moved into structure, allowing headings and categories', () => {
    const bad = valid();
    bad.structure.push(...bad.tabs.pop()!.paragraphs);
    expect(checkProposal(bad, doc).errors).toEqual([
      'Paragraph 4 is in structure but is not a heading.',
    ]);

    const heading = docx([
      h('Beliefs'),
      { text: 'a' },
      h('A heading I added', 3),
      h('', 3),
    ]);
    const proposal = proposeStructure(INPUT, heading);
    proposal.structure.push(3);
    expect(checkProposal(proposal, heading).errors).toEqual([
      'Paragraph 3 is in structure but is not a heading.',
    ]);
    proposal.structure.pop();
    proposal.structure.push(99);
    expect(checkProposal(proposal, heading).errors).toEqual([
      'a heading: paragraph 99 does not exist.',
    ]);
  });

  it('flags a heading whose text or picture ends up nowhere', () => {
    const headed = docx([
      h('Beliefs'),
      { text: 'a' },
      { ...h('I believe this but styled it as a heading', 3) },
      { ...h('Photo', 3), images: ['word/media/image1.png'] },
      { text: 'b' },
    ]);
    expect(
      checkProposal(proposeStructure(INPUT, headed), headed).reviewFlags,
    ).toEqual([
      'Heading at paragraph 2 is not kept anywhere; check it is not a belief.',
      'Heading at paragraph 3 holds an image that will not be imported.',
    ]);
  });

  it('keeps a reply with its parent, wherever the reply itself points', () => {
    const replies = docx(
      [h('Beliefs'), num('one', 0), num('two', 0)],
      [
        comment('p', [1]),
        { ...comment('no-range', [], false), parentId: 'p' },
        { ...comment('elsewhere', [2]), parentId: 'p' },
        { ...comment('grandchild', [], false), parentId: 'elsewhere' },
        { ...comment('orphan', [2]), parentId: 'missing' },
      ],
    );
    expect(
      checkProposal(proposeStructure(INPUT, replies), replies).placements,
    ).toEqual([
      { commentId: 'p', tab: 0, paragraph: 1 },
      { commentId: 'no-range', tab: 0, paragraph: 1 },
      { commentId: 'elsewhere', tab: 0, paragraph: 1 },
      { commentId: 'grandchild', tab: 0, paragraph: 1 },
      { commentId: 'orphan', tab: 1, paragraph: 2 },
    ]);
  });

  it('refuses replies that form a loop', () => {
    const looped = docx(
      [h('Beliefs'), num('one', 0)],
      [
        { ...comment('a', [1]), parentId: 'b' },
        { ...comment('b', [1]), parentId: 'a' },
      ],
    );
    expect(
      checkProposal(proposeStructure(INPUT, looped), looped).errors,
    ).toEqual([
      'Comment a: its replies form a loop.',
      'Comment b: its replies form a loop.',
    ]);
  });

  it('ignores a dropped index that does not exist when sizing a drop', () => {
    const proposal = valid();
    proposal.dropped.push({ paragraphs: [97, 98, 99, 100, 101], reason: 'x' });
    expect(checkProposal(proposal, doc).reviewFlags).not.toContainEqual(
      expect.stringContaining('dropped: x'),
    );
  });

  it('never proposes a template picture or a HEIC photo', () => {
    const template = {
      ...dataFile('Data/IMG_0002-49.jpeg', 900),
      sha256: 'a'.repeat(64),
    };
    const proposal = proposeStructure(
      INPUT,
      doc,
      pages([
        template,
        dataFile('Data/IMG_0003-56.heic', 800),
        dataFile('Data/me.jpeg', 10),
      ]),
      { templateSha256: new Set(['a'.repeat(64)]) },
    );
    expect(proposal.images).toEqual({ picture: 'Data/me.jpeg', gallery: [] });
  });

  it('refuses a HEIC picture chosen by hand', () => {
    const proposal = valid();
    proposal.images = { picture: 'Data/x.heic', gallery: [] };
    expect(
      checkProposal(proposal, doc, pages([dataFile('Data/x.heic', 1)])).errors,
    ).toEqual([
      'Image Data/x.heic is HEIC, which cannot be converted: use the JPEG copy in the .docx (word/media/).',
    ]);
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
