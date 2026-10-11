import type { DocxDocument } from './docx-reader';
import type { ImportPlan } from './import-plan';
import type { CheckStatus, CrossCheck } from './pages-reader';
import type { ProposalCheck } from './proposal';

export interface ProfileReport {
  slug: string;
  /**
   * `ok`: safe to import. `mismatch`: something disagrees (proposal errors,
   * reader warnings, a .pages cross-check miss). `cannot-measure`: a check
   * could not run (no .pages file, or no author table in it).
   */
  status: CheckStatus;
  reasons: string[];
  counts: {
    paragraphs: number;
    tabs: number;
    blocks: number;
    comments: number;
    replies: number;
    commentsOnTabs: number;
    commentsSpanningTabs: number;
    imageBlocks: number;
    profileImages: number;
  };
  /** Comments that land on the profile's "Imported comments" list, and why. */
  unplacedComments: { commentId: string; reason: string }[];
  crossCheck?: CrossCheck;
  readerWarnings: string[];
  proposalErrors: string[];
  unmappedPagesLinks: string[];
}

/**
 * Summarises one profile's import checks. A profile is `ok` only when every
 * check ran and passed; an unplaced comment is NOT a failure (it is placed on
 * the profile with its reason, and listed here), everything else is.
 */
export function buildProfileReport(
  slug: string,
  docx: DocxDocument,
  check: ProposalCheck,
  plan: ImportPlan | undefined,
  crossCheck: CrossCheck | undefined,
): ProfileReport {
  const reasons: string[] = [];
  if (check.errors.length > 0) {
    reasons.push(`${check.errors.length} proposal error(s)`);
  }
  if (docx.warnings.length > 0) {
    reasons.push(`${docx.warnings.length} .docx reader warning(s)`);
  }
  if (crossCheck?.status === 'mismatch') {
    reasons.push('.pages cross-check found differences');
  }

  let status: CheckStatus = reasons.length > 0 ? 'mismatch' : 'ok';
  if (status === 'ok' && crossCheck?.status !== 'ok') {
    status = 'cannot-measure';
    reasons.push(
      crossCheck
        ? '.pages has no comment-author table'
        : 'no .pages file to cross-check against',
    );
  }

  return {
    slug,
    status,
    reasons,
    counts: {
      paragraphs: docx.paragraphs.length,
      tabs: plan?.tabs.length ?? 0,
      blocks: plan?.blocks.length ?? 0,
      comments: docx.comments.length,
      replies: docx.comments.filter((comment) => comment.parentId).length,
      commentsOnTabs: check.placements.filter((p) => p.tab !== undefined)
        .length,
      commentsSpanningTabs: check.placements.filter((p) => p.spansTabs).length,
      imageBlocks:
        plan?.blocks.filter((block) => block.kind === 'image').length ?? 0,
      profileImages: plan?.images.length ?? 0,
    },
    unplacedComments: check.placements
      .filter((p) => p.unplaced)
      .map((p) => ({ commentId: p.commentId, reason: p.unplaced! })),
    ...(crossCheck ? { crossCheck } : {}),
    readerWarnings: docx.warnings,
    proposalErrors: check.errors,
    unmappedPagesLinks: plan?.unmappedPagesLinks ?? [],
  };
}

/** The overall result: the worst profile status (mismatch > cannot-measure > ok). */
export function overallStatus(reports: ProfileReport[]): CheckStatus {
  if (reports.some((report) => report.status === 'mismatch')) return 'mismatch';
  if (reports.some((report) => report.status === 'cannot-measure')) {
    return 'cannot-measure';
  }
  return 'ok';
}
