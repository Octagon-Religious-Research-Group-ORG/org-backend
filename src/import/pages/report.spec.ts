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
  placements: [
    { commentId: '1', tab: 0, paragraph: 0, spansTabs: true },
    { commentId: '2', unplaced: 'not-anchored' as const },
  ],
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
      [],
      ['Image x could not be converted: bad'],
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
      ['Review is void: the .docx has changed since this review.'],
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
      buildProfileReport('tripp', docx(), check(), plan, cross('ok')),
    ).toEqual({
      slug: 'tripp',
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
      'tripp',
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
