import {
  type DocxDocument,
  isDuplicateCommentWarning,
  warningParagraph,
} from './docx-reader';
import type { ImportPlan } from './import-plan';
import type { CheckStatus, CrossCheck } from './pages-reader';
import {
  type ProposalCheck,
  type ReviewBinding,
  reviewInstruction,
} from './proposal';

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
  /** Reader warnings that only concern dropped Legal paragraphs; they do not block. */
  warningsInLegal: string[];
  /** Exact texts a reviewer may name in `reviewed.acceptedWarnings`. */
  acceptableWarnings: string[];
  proposalErrors: string[];
  unmappedPagesLinks: string[];
  /** Addresses removed as unsafe; the visible text of each link is kept. */
  unsafeLinks: string[];
  /** Valid-but-suspicious findings; they block the import until reviewed. */
  reviewFlags: string[];
  reviewed: boolean;
  /** Rows or pictures the real write would reject (see `preflightImport`). */
  preflightErrors: string[];
  /** Size of the Legal section left out (plan §2b), reported on every profile. */
  legalDropped: ProposalCheck['legalDropped'];
}

export interface ReportOptions {
  reviewProblems?: string[];
  preflightErrors?: string[];
  /** Current hashes, so the block message can say exactly what to add. */
  binding?: ReviewBinding;
  /** From a valid review only; ignored unless `reviewed` is true. */
  acceptedWarnings?: string[];
}

/** Author problems a person may accept, one exact text for each. */
function authorWarnings(crossCheck: CrossCheck): string[] {
  if (crossCheck.authors.status === 'cannot-measure') {
    return [
      'The .pages has no comment-author table, so comment authors could not be checked.',
    ];
  }
  return crossCheck.authors.missing.map(
    (author) => `Comment author "${author}" is not in the .pages author table.`,
  );
}

/**
 * Summarises one profile's import checks. A profile is `ok` only when every
 * check ran and passed; an unplaced comment is NOT a failure (it is placed on
 * the profile with its reason, and listed here), everything else is. Reader
 * warnings and author differences can be accepted by a valid review that
 * names them; a comment missing from the .pages can never be.
 */
export function buildProfileReport(
  slug: string,
  docx: DocxDocument,
  check: ProposalCheck,
  plan: ImportPlan | undefined,
  crossCheck: CrossCheck | undefined,
  reviewed = false,
  options: ReportOptions = {},
): ProfileReport {
  const { reviewProblems = [], preflightErrors = [] } = options;
  const reasons: string[] = [...reviewProblems];
  if (preflightErrors.length > 0) {
    reasons.push(`${preflightErrors.length} row or picture check(s) failed`);
  }
  const reviewFlags = [...check.reviewFlags];
  if (crossCheck?.commentsLost) {
    reviewFlags.push(
      `The .docx has no comments, but the .pages names comment author(s): ${crossCheck.authors.pagesOnly.join(', ')}. Confirm no comments were lost.`,
    );
  } else if (crossCheck && crossCheck.authors.pagesOnly.length > 0) {
    reviewFlags.push(
      `The .pages names author(s) with no comment in the .docx, so comments may be lost: ${crossCheck.authors.pagesOnly.join(', ')}.`,
    );
  }
  if (plan && plan.unsafeLinks.length > 0) {
    reviewFlags.push(
      `${plan.unsafeLinks.length} link address(es) removed as unsafe, keeping their text.`,
    );
  }
  if (reviewFlags.length > 0 && !reviewed) {
    reasons.push(
      `needs review: ${reviewFlags.length} flag(s), no reviewer recorded`,
    );
  }
  if (check.errors.length > 0) {
    reasons.push(`${check.errors.length} proposal error(s)`);
  }
  const legal = new Set(check.legalParagraphs);
  const warningsInLegal = docx.warnings.filter((warning) =>
    legal.has(warningParagraph(warning) ?? -1),
  );
  const located = docx.warnings.filter(
    (warning) => !warningsInLegal.includes(warning),
  );
  const duplicates = located.filter(isDuplicateCommentWarning);
  if (duplicates.length > 0) {
    reasons.push(
      `${duplicates.length} duplicate comment id(s): two comments cannot be stored under one id, so a review cannot accept this; correct the export.`,
    );
  }
  const warnings = located.filter((w) => !isDuplicateCommentWarning(w));
  const accepted = new Set(reviewed ? (options.acceptedWarnings ?? []) : []);
  const pendingWarnings = warnings.filter((w) => !accepted.has(w));
  if (pendingWarnings.length > 0) {
    reasons.push(`${pendingWarnings.length} .docx reader warning(s)`);
  }

  const authorIssues = crossCheck ? authorWarnings(crossCheck) : [];
  const pendingAuthors = authorIssues.filter((w) => !accepted.has(w));
  const hardMismatch =
    (crossCheck?.comments.missing.length ?? 0) > 0 ||
    (crossCheck?.status === 'mismatch' && authorIssues.length === 0);
  if (
    hardMismatch ||
    (crossCheck?.authors.status === 'mismatch' && pendingAuthors.length > 0)
  ) {
    reasons.push('.pages cross-check found differences');
  }

  const crossMeasured =
    crossCheck?.status === 'ok' ||
    (authorIssues.length > 0 && pendingAuthors.length === 0);
  let status: CheckStatus = reasons.length > 0 ? 'mismatch' : 'ok';
  if (status === 'ok' && !crossMeasured) {
    status = 'cannot-measure';
    reasons.push(
      crossCheck
        ? '.pages has no comment-author table'
        : 'no .pages file to cross-check against',
    );
  }

  const reviewCanFix =
    reviewProblems.length > 0 ||
    (reviewFlags.length > 0 && !reviewed) ||
    pendingWarnings.length > 0 ||
    pendingAuthors.length > 0;
  if (reviewCanFix && options.binding) {
    reasons.push(
      reviewInstruction(options.binding, [...warnings, ...authorIssues]),
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
    warningsInLegal,
    acceptableWarnings: [...new Set([...warnings, ...authorIssues])],
    proposalErrors: check.errors,
    unmappedPagesLinks: plan?.unmappedPagesLinks ?? [],
    unsafeLinks: plan?.unsafeLinks ?? [],
    reviewFlags,
    reviewed,
    preflightErrors,
    legalDropped: check.legalDropped,
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
