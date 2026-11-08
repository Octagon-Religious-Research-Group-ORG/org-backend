import type { DocxDocument } from './docx-reader';
import type { ImportPlan } from './import-plan';
import type { CrossCheck } from './pages-reader';
import {
  buildProfileReport,
  overallStatus,
  type ProfileReport,
} from './report';

const docx = (warnings: string[] = []): DocxDocument => ({
  paragraphs: [
    { index: 0, style: '', text: 'x', links: [], images: [], inTable: false },
  ],
  comments: [
    {
      id: '1',
      author: 'A',
      text: 'c',
      anchorText: 'x',
      paragraphIndices: [0],
      anchored: true,
    },
    {
      id: '2',
      author: 'B',
      text: 'r',
      parentId: '1',
      anchorText: '',
      paragraphIndices: [],
      anchored: false,
    },
  ],
  media: new Map(),
  warnings,
});

const cross = (status: CrossCheck['status']): CrossCheck => ({
  comments: { total: 2, found: 2, missing: [] },
  authors: { status, total: 2, found: 2, missing: [], pagesOnly: [] },
  commentsLost: false,
  status,
});

const plan = {
  tabs: [{ tabId: 't', title: 'x', order: 0 }],
  blocks: [{ kind: 'paragraph' }, { kind: 'image' }],
  images: [{ path: 'Data/p.jpeg', role: 'picture' }],
  unmappedPagesLinks: ['https://www.icloud.com/pages/X'],
  unsafeLinks: [],
} as unknown as ImportPlan;

const check = (errors: string[] = [], reviewFlags: string[] = []) => ({
  errors,
  reviewFlags,
  legalDropped: { paragraphs: 2, characters: 40 },
  legalParagraphs: [],
  placements: [
    { commentId: '1', tab: 0, paragraph: 0, spansTabs: true },
    { commentId: '2', unplaced: 'not-anchored' as const },
  ],
});

describe('buildProfileReport accepted warnings', () => {
  const binding = {
    sourceSha256: 'd'.repeat(64),
    pagesSha256: 'p'.repeat(64),
    proposalSha256: 'r'.repeat(64),
  };
  const authorWarning = 'Comment author "B" is not in the .pages author table.';
  const authorsMismatch = (missing: string[]): CrossCheck => ({
    comments: { total: 2, found: 2, missing: [] },
    authors: { status: 'mismatch', total: 2, found: 1, missing, pagesOnly: [] },
    commentsLost: false,
    status: 'mismatch',
  });

  it('blocks a warning nobody accepted, printing exactly what to add', () => {
    const report = buildProfileReport(
      'a',
      docx(['w1']),
      check(),
      plan,
      cross('ok'),
      false,
      { binding },
    );

    expect(report.status).toBe('mismatch');
    expect(report.reasons[0]).toBe('1 .docx reader warning(s)');
    expect(report.reasons[1]).toContain('"sourceSha256":"' + 'd'.repeat(64));
    expect(report.reasons[1]).toContain('"pagesSha256":"' + 'p'.repeat(64));
    expect(report.reasons[1]).toContain('"proposalSha256":"' + 'r'.repeat(64));
    expect(report.reasons[1]).toContain('"acceptedWarnings":["w1"]');
    expect(report.acceptableWarnings).toEqual(['w1']);
  });

  it('accepts a named warning only with a valid review', () => {
    const named = { binding, acceptedWarnings: ['w1'] };
    expect(
      buildProfileReport(
        'a',
        docx(['w1']),
        check(),
        plan,
        cross('ok'),
        true,
        named,
      ).status,
    ).toBe('ok');
    expect(
      buildProfileReport(
        'a',
        docx(['w1']),
        check(),
        plan,
        cross('ok'),
        false,
        named,
      ).status,
    ).toBe('mismatch');
  });

  it('still blocks a warning the review did not name', () => {
    const report = buildProfileReport(
      'a',
      docx(['w1', 'w2']),
      check(),
      plan,
      cross('ok'),
      true,
      { acceptedWarnings: ['w1'] },
    );
    expect(report.reasons).toEqual(['1 .docx reader warning(s)']);
  });

  it('lets a review accept a missing author', () => {
    const blocked = buildProfileReport(
      'a',
      docx(),
      check(),
      plan,
      authorsMismatch(['B']),
      true,
    );
    expect(blocked.status).toBe('mismatch');
    expect(blocked.acceptableWarnings).toEqual([authorWarning]);

    const accepted = buildProfileReport(
      'a',
      docx(),
      check(),
      plan,
      authorsMismatch(['B']),
      true,
      { acceptedWarnings: [authorWarning] },
    );
    expect(accepted.status).toBe('ok');
    expect(accepted.reasons).toEqual([]);
  });

  it('keeps blocking a second author when only the first is accepted', () => {
    const other = 'Comment author "C" is not in the .pages author table.';
    const report = buildProfileReport(
      'a',
      docx(),
      check(),
      plan,
      authorsMismatch(['B', 'C']),
      true,
      { acceptedWarnings: [authorWarning] },
    );
    expect(report.status).toBe('mismatch');
    expect(report.reasons).toEqual(['.pages cross-check found differences']);
    expect(report.acceptableWarnings).toEqual([authorWarning, other]);
  });

  it('never accepts a duplicate comment id, and does not offer to', () => {
    const duplicate = 'Comment 1 appears more than once in comments.xml.';
    const report = buildProfileReport(
      'a',
      docx([duplicate]),
      check(),
      plan,
      cross('ok'),
      true,
      { binding, acceptedWarnings: [duplicate] },
    );
    expect(report.status).toBe('mismatch');
    expect(report.reasons).toEqual([
      '1 duplicate comment id(s): two comments cannot be stored under one id, so a review cannot accept this; correct the export.',
    ]);
    expect(report.acceptableWarnings).toEqual([]);
  });

  it('never accepts a comment missing from the .pages', () => {
    const missing: CrossCheck = {
      ...authorsMismatch(['B']),
      comments: { total: 2, found: 1, missing: ['7'] },
    };
    const report = buildProfileReport(
      'a',
      docx(),
      check(),
      plan,
      missing,
      true,
      { acceptedWarnings: [authorWarning, '7'] },
    );
    expect(report.status).toBe('mismatch');
    expect(report.reasons).toEqual(['.pages cross-check found differences']);
  });

  it('lets a review accept a .pages with no author table, not one with no .pages', () => {
    const noTable = cross('cannot-measure');
    const text =
      'The .pages has no comment-author table, so comment authors could not be checked.';
    expect(
      buildProfileReport('a', docx(), check(), plan, noTable, true, {
        acceptedWarnings: [text],
      }).status,
    ).toBe('ok');
    expect(
      buildProfileReport('a', docx(), check(), plan, noTable, true).status,
    ).toBe('cannot-measure');
    expect(
      buildProfileReport('a', docx(), check(), plan, undefined, true, {
        acceptedWarnings: [text],
      }).status,
    ).toBe('cannot-measure');
  });

  it('does not block on a warning located only in dropped Legal paragraphs', () => {
    const inLegal = 'Paragraph 9: a footnote or endnote cannot be imported.';
    const legal = { ...check(), legalParagraphs: [9] };
    const report = buildProfileReport(
      'a',
      docx([inLegal, 'Paragraph 3: other']),
      legal,
      plan,
      cross('ok'),
    );
    expect(report.warningsInLegal).toEqual([inLegal]);
    expect(report.reasons).toEqual(['1 .docx reader warning(s)']);

    const docWide = buildProfileReport(
      'a',
      docx(['Comment 1 appears twice']),
      legal,
      plan,
      cross('ok'),
    );
    expect(docWide.status).toBe('mismatch');
  });

  it('flags no comments against named authors instead of refusing', () => {
    const lost: CrossCheck = {
      comments: { total: 0, found: 0, missing: [] },
      authors: {
        status: 'ok',
        total: 0,
        found: 0,
        missing: [],
        pagesOnly: ['Gone'],
      },
      commentsLost: true,
      status: 'ok',
    };
    const flagged = buildProfileReport('a', docx(), check(), plan, lost);
    expect(flagged.reviewFlags).toEqual([
      'The .docx has no comments, but the .pages names comment author(s): Gone. Confirm no comments were lost.',
    ]);
    expect(flagged.status).toBe('mismatch');
    expect(
      buildProfileReport('a', docx(), check(), plan, lost, true).status,
    ).toBe('ok');
  });

  it('says nothing about a review when review cannot help', () => {
    const report = buildProfileReport(
      'a',
      docx(),
      check(['e']),
      plan,
      cross('ok'),
      false,
      { binding },
    );
    expect(report.reasons).toEqual(['1 proposal error(s)']);
  });
});

describe('buildProfileReport', () => {
  it('fails a profile whose rows or pictures would be rejected', () => {
    const report = buildProfileReport(
      'a',
      docx(),
      check(),
      plan,
      cross('ok'),
      false,
      { preflightErrors: ['Image x could not be converted: bad'] },
    );
    expect(report.status).toBe('mismatch');
    expect(report.reasons).toEqual(['1 row or picture check(s) failed']);
    expect(report.preflightErrors).toEqual([
      'Image x could not be converted: bad',
    ]);
  });

  it('reports removed link addresses and needs a review for them', () => {
    const report = buildProfileReport(
      'a',
      docx(),
      check(),
      { ...plan, unsafeLinks: ['javascript:alert(1)'] },
      cross('ok'),
    );
    expect(report.unsafeLinks).toEqual(['javascript:alert(1)']);
    expect(report.reviewFlags).toEqual([
      '1 link address(es) removed as unsafe, keeping their text.',
    ]);
    expect(report.status).toBe('mismatch');
  });

  it('blocks a profile whose recorded review is void, flags or no flags', () => {
    const report = buildProfileReport(
      'a',
      docx(),
      check(),
      plan,
      cross('ok'),
      false,
      {
        reviewProblems: [
          'Review is void: the .docx has changed since this review.',
        ],
      },
    );
    expect(report.status).toBe('mismatch');
    expect(report.reasons).toEqual([
      'Review is void: the .docx has changed since this review.',
    ]);
  });

  it('needs a review when the .pages names an author with no comment', () => {
    const pagesOnly = {
      ...cross('ok'),
      authors: { ...cross('ok').authors, pagesOnly: ['Lost Author'] },
    };
    const report = buildProfileReport('a', docx(), check(), plan, pagesOnly);
    expect(report.status).toBe('mismatch');
    expect(report.reviewFlags).toEqual([
      'The .pages names author(s) with no comment in the .docx, so comments may be lost: Lost Author.',
    ]);
    expect(report.reasons).toEqual([
      'needs review: 1 flag(s), no reviewer recorded',
    ]);
  });

  it('is ok when every check ran and passed, listing unplaced comments', () => {
    expect(
      buildProfileReport('bram', docx(), check(), plan, cross('ok')),
    ).toEqual({
      slug: 'bram',
      status: 'ok',
      reasons: [],
      counts: {
        paragraphs: 1,
        tabs: 1,
        blocks: 2,
        comments: 2,
        replies: 1,
        commentsOnTabs: 1,
        commentsSpanningTabs: 1,
        imageBlocks: 1,
        profileImages: 1,
      },
      unplacedComments: [{ commentId: '2', reason: 'not-anchored' }],
      crossCheck: cross('ok'),
      readerWarnings: [],
      proposalErrors: [],
      unmappedPagesLinks: ['https://www.icloud.com/pages/X'],
      reviewFlags: [],
      reviewed: false,
      legalDropped: { paragraphs: 2, characters: 40 },
      unsafeLinks: [],
      preflightErrors: [],
      warningsInLegal: [],
      acceptableWarnings: [],
    });
  });

  it('blocks a proposal with review flags until a reviewer is recorded', () => {
    const flagged = check([], ['No belief tabs.']);

    const blocked = buildProfileReport('t', docx(), flagged, plan, cross('ok'));
    expect(blocked.status).toBe('mismatch');
    expect(blocked.reasons).toEqual([
      'needs review: 1 flag(s), no reviewer recorded',
    ]);
    expect(blocked.reviewFlags).toEqual(['No belief tabs.']);

    const reviewed = buildProfileReport(
      't',
      docx(),
      flagged,
      plan,
      cross('ok'),
      true,
    );
    expect([reviewed.status, reviewed.reasons, reviewed.reviewed]).toEqual([
      'ok',
      [],
      true,
    ]);
  });

  it('is a mismatch for proposal errors, reader warnings or a cross-check miss', () => {
    const report = buildProfileReport(
      'bram',
      docx(['w']),
      check(['e1', 'e2']),
      undefined,
      cross('mismatch'),
    );

    expect(report.status).toBe('mismatch');
    expect(report.reasons).toEqual([
      '2 proposal error(s)',
      '1 .docx reader warning(s)',
      '.pages cross-check found differences',
    ]);
    expect(report.counts).toEqual(
      expect.objectContaining({
        tabs: 0,
        blocks: 0,
        imageBlocks: 0,
        profileImages: 0,
      }),
    );
    expect(report.unmappedPagesLinks).toEqual([]);
  });

  it.each([
    [undefined, 'no .pages file to cross-check against'],
    [cross('cannot-measure'), '.pages has no comment-author table'],
  ])('cannot measure without a full cross-check (%#)', (crossCheck, reason) => {
    const report = buildProfileReport('t', docx(), check(), plan, crossCheck);

    expect(report.status).toBe('cannot-measure');
    expect(report.reasons).toEqual([reason]);
  });
});

describe('overallStatus', () => {
  const r = (status: ProfileReport['status']) => ({ status }) as ProfileReport;

  it.each([
    [[r('ok'), r('cannot-measure'), r('mismatch')], 'mismatch'],
    [[r('ok'), r('cannot-measure')], 'cannot-measure'],
    [[r('ok')], 'ok'],
    [[], 'ok'],
  ])('reports the worst status (%#)', (reports, expected) => {
    expect(overallStatus(reports)).toBe(expected);
  });
});
