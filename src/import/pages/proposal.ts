import type { BlockSection } from '../../social/schemas/profile-block.schema';
import type { ProfileVisibility } from '../../social/schemas/social-profile.schema';
import { SLUG_PATTERN } from '../../social/schemas/social-profile.schema';
import type { DocxDocument, DocxParagraph } from './docx-reader';
import type { PagesPackage } from './pages-reader';

export const PROPOSAL_VERSION = 1;

/**
 * How one Apple Pages profile becomes a site profile. Generated automatically,
 * then reviewed (and edited by hand where the text is free-flowing, plan §2c)
 * before anything is written. Every paragraph is accounted for: placed in a
 * section or a tab, consumed as a heading, or dropped WITH A REASON.
 */
export interface ProfileProposal {
  version: typeof PROPOSAL_VERSION;
  slug: string;
  displayName: string;
  pagesUrl: string;
  visibility: ProfileVisibility;
  /** The member uses a nickname (plan §2b); absent means false. */
  anonymous?: boolean;
  sections: ProposalSection[];
  tabs: ProposalTab[];
  /** Headings consumed as structure (section titles, category names). */
  structure: number[];
  dropped: { paragraphs: number[]; reason: string }[];
  /** Package paths: a Pages `Data/` file or a .docx `word/media/` file. */
  images: { picture?: string; gallery: string[] };
  /**
   * Set by the person who checked this proposal against the document. A
   * proposal with review flags (see `checkProposal`) is not imported without it.
   */
  reviewed?: { by: string; at: string; note?: string };
}

/** A tab longer than this is probably several beliefs (one belief per tab, §2c). */
export const LONG_TAB_PARAGRAPHS = 15;

/** Dropping more than this outside the Legal section needs a person's look. */
export const DROP_REVIEW_PARAGRAPHS = 3;

export interface ProposalSection {
  section: Exclude<BlockSection, 'beliefs' | 'legal'>;
  /** The member's own heading, kept for `other` sections. */
  heading?: string;
  paragraphs: number[];
}

export interface ProposalTab {
  title: string;
  /** The member's category heading (Tripp's "Theology", …), if any. */
  group?: string;
  paragraphs: number[];
}

export interface ProposalInput {
  slug: string;
  displayName: string;
  pagesUrl: string;
  visibility: ProfileVisibility;
  anonymous?: boolean;
}

type Kind = 'bio' | 'beliefs' | 'bio-beliefs' | 'contact' | 'legal' | 'other';

/** Section headings as members wrote them, matched case- and space-insensitively. */
function sectionKind(heading: string): Kind {
  const text = heading.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^bio(graphy)?$/.test(text)) return 'bio';
  if (/^(my )?beliefs?$/.test(text)) return 'beliefs';
  if (/^bio(graphy)? ?(&|and|\+) ?(my )?beliefs?$/.test(text)) {
    return 'bio-beliefs';
  }
  if (/^contact( info(rmation)?)?$/.test(text)) return 'contact';
  if (/^legal\b/.test(text)) return 'legal';
  return 'other';
}

/** A typed top-level label: a Roman numeral ("III.") or "Belief 3". */
const LITERAL_TOP_LABEL = /^\s*(?:([IVXLC]+)[.)]|belief\s+(\d+)[.:)]?)\s+/i;

/** A bullet character starting a paragraph ("•I believe…"). Not "-": members use "---" as separators. */
const BULLET = /^\s*[•●▪◦‣]\s*/;

/** A paragraph that is only a separator line ("---", "***"). */
const SEPARATOR = /^\s*([-*_=~]\s*){3,}$/;

/**
 * Tripp's onboarding template wraps its instructions in parentheses ("(Add any
 * beliefs/ideas you want…)"). A paragraph that is ONLY a parenthesis is an
 * unfilled hint, not the member's words. Always flagged for review.
 */
const PLACEHOLDER = /^\s*\([\s\S]*\)\s*$/;

/** First line of Tripp's onboarding template, copied to the top of new pages. */
const ONBOARDING_TEMPLATE = /^public membership:?$/i;

/** Image formats the converter cannot read (sharp ships without HEVC). */
export const UNREADABLE_IMAGE = /.(heic|heif)$/i;

export const PLACEHOLDER_REASON =
  'Unfilled template placeholder (instructions in parentheses)';
export const ONBOARDING_REASON =
  "Onboarding template copied into the page (Tripp's membership instructions), not the member's own text";

const ROMAN: [number, string][] = [
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

/** Value of a well-formed Roman numeral up to 399, or NaN ("IIII", "VX"). */
export function romanValue(numeral: string): number {
  const upper = numeral.toUpperCase();
  if (!upper) return NaN;
  let rest = upper;
  let total = 0;
  for (const [amount, symbol] of ROMAN) {
    while (rest.startsWith(symbol)) {
      total += amount;
      rest = rest.slice(symbol.length);
    }
  }
  if (rest !== '') return NaN;
  // Canonical form only: re-encoding must give the same text back.
  let canonical = '';
  let left = total;
  for (const [amount, symbol] of ROMAN) {
    while (left >= amount) {
      canonical += symbol;
      left -= amount;
    }
  }
  return canonical === upper ? total : NaN;
}

/**
 * The number a typed top-level label stands for, or undefined. "C." alone is
 * ambiguous (the letter C, or the Roman 100), so callers accept a typed label
 * only as the NEXT number in sequence, or 1 (a restart). That is what keeps a
 * sub-point "C." from starting a new belief.
 */
function literalTopNumber(text: string): number | undefined {
  const match = LITERAL_TOP_LABEL.exec(text);
  if (!match) return undefined;
  const value = match[1] ? romanValue(match[1]) : Number(match[2]);
  return Number.isNaN(value) ? undefined : value;
}

/** Paragraphs that carry content (text or an image). */
export function contentParagraphs(docx: DocxDocument): DocxParagraph[] {
  return docx.paragraphs.filter(
    (paragraph) => paragraph.text.trim() !== '' || paragraph.images.length > 0,
  );
}

function tabTitle(paragraph: DocxParagraph): string {
  const firstLine = paragraph.text
    .trim()
    .split('\n')[0]
    .replace(BULLET, '')
    .trim();
  const label = paragraph.numbering?.label ?? '';
  const title = label ? `${label} ${firstLine}` : firstLine;
  return title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title;
}

interface BeliefEntry {
  paragraph: DocxParagraph;
  group?: string;
}

/**
 * Splits one run of belief paragraphs (one category) into tabs:
 *
 * - a category written as a single short numbered item with lettered
 *   sub-points ("I. Christian beliefs", A., B., …) names the group, and each
 *   sub-point is a tab;
 * - otherwise a tab starts at Word numbering level 0, at a typed label that is
 *   NEXT in sequence ("C." after "III." is a sub-point, not Roman 100), or at
 *   a bullet;
 * - with no labels or bullets at all, each paragraph is its own tab.
 * Text before the first belief becomes its own "(introduction)" tab.
 */
function splitBeliefs(
  entries: BeliefEntry[],
  structure: number[],
): ProposalTab[] {
  const group = entries[0].group;
  const numbered = entries.filter((entry) => entry.paragraph.numbering);
  const topLevel = numbered.filter(
    (entry) => entry.paragraph.numbering!.level === 0,
  );
  const firstTop = topLevel[0]?.paragraph;
  const categoryItem =
    topLevel.length === 1 &&
    numbered.filter((entry) => entry.paragraph.numbering!.level === 1).length >=
      2 &&
    firstTop.text.trim().length <= 60 &&
    !/[.!?]$/.test(firstTop.text.trim())
      ? firstTop
      : undefined;
  const splitLevel = categoryItem ? 1 : 0;
  const tabGroup = categoryItem ? categoryItem.text.trim() : group;

  const labelled = entries.some(
    (entry) =>
      entry.paragraph.numbering !== undefined ||
      BULLET.test(entry.paragraph.text) ||
      literalTopNumber(entry.paragraph.text.trim()) !== undefined,
  );

  let lastTop = 0;
  const tabs: ProposalTab[] = [];
  let tab: ProposalTab | undefined;
  for (const { paragraph } of entries) {
    if (paragraph === categoryItem) {
      structure.push(paragraph.index);
      continue;
    }
    const text = paragraph.text.trim();
    const typed = paragraph.numbering ? undefined : literalTopNumber(text);
    const sequential =
      typed !== undefined && (typed === lastTop + 1 || typed === 1);
    const startsBelief =
      !labelled ||
      paragraph.numbering?.level === splitLevel ||
      BULLET.test(text) ||
      sequential;
    if (paragraph.numbering?.level === 0) lastTop += 1;
    else if (sequential) lastTop = typed;
    if (startsBelief || !tab) {
      tab = {
        title: startsBelief
          ? tabTitle(paragraph)
          : `${tabGroup ?? 'Beliefs'} (introduction)`,
        ...(tabGroup ? { group: tabGroup } : {}),
        paragraphs: [],
      };
      tabs.push(tab);
    }
    tab.paragraphs.push(paragraph.index);
  }
  return tabs;
}

/**
 * Proposes the structure of one profile:
 *
 * - Section headings (any heading level) named Bio, Beliefs, "Bio & Beliefs",
 *   Contact, Legal start those sections; any other non-empty heading at the
 *   same level starts an `other` section under the member's own words.
 * - Inside Beliefs, a deeper heading names a category (`group`), and each
 *   category is split into tabs by `splitBeliefs`. In a combined "Bio &
 *   Beliefs" section, bullet paragraphs are beliefs (one tab each) and the
 *   rest is the bio.
 * - Dropped, each with its reason: everything before the first section (or
 *   the onboarding template, named as such), Legal (Tripp, §2b), unfilled
 *   template placeholders, separator lines.
 * - Images: Pages' full-size photos, excluding template art (the same file in
 *   several members' pages: navigation tiles, the example picture), HEIC and
 *   thumbnails; the largest is proposed as the picture. File names are NOT a
 *   signal: two members' real photos are named "pasted-movie-…".
 */
export function proposeStructure(
  input: ProposalInput,
  docx: DocxDocument,
  pages?: PagesPackage,
  options: { templateSha256?: ReadonlySet<string> } = {},
): ProfileProposal {
  const proposal: ProfileProposal = {
    version: PROPOSAL_VERSION,
    ...input,
    sections: [],
    tabs: [],
    structure: [],
    dropped: [],
    images: { gallery: [] },
  };

  const preamble: number[] = [];
  const legal: number[] = [];
  const placeholders: number[] = [];
  const separators: number[] = [];
  const beliefRuns: BeliefEntry[][] = [];
  let kind: Kind | undefined;
  let sectionLevel = 0;
  let current: ProposalSection | undefined;
  let run: BeliefEntry[] | undefined;
  let group: string | undefined;

  const openSection = (
    section: ProposalSection['section'],
    heading?: string,
  ): ProposalSection => {
    current = { section, ...(heading ? { heading } : {}), paragraphs: [] };
    proposal.sections.push(current);
    return current;
  };

  for (const paragraph of contentParagraphs(docx)) {
    const text = paragraph.text.trim();
    const level = paragraph.headingLevel;
    const isSectionHeading =
      level !== undefined &&
      level > 0 &&
      text !== '' &&
      (kind === undefined
        ? sectionKind(text) !== 'other'
        : level <= sectionLevel || sectionKind(text) !== 'other');

    if (isSectionHeading) {
      kind = sectionKind(text);
      sectionLevel = level;
      proposal.structure.push(paragraph.index);
      run = undefined;
      group = undefined;
      current = undefined;
      if (kind === 'bio' || kind === 'contact') openSection(kind);
      if (kind === 'other') openSection('other', text);
      continue;
    }

    if (kind === undefined) {
      preamble.push(paragraph.index);
      continue;
    }
    if (kind === 'legal') {
      legal.push(paragraph.index);
      continue;
    }
    if (PLACEHOLDER.test(text)) {
      placeholders.push(paragraph.index);
      continue;
    }
    if (SEPARATOR.test(text)) {
      separators.push(paragraph.index);
      continue;
    }
    if (kind === 'bio' || kind === 'contact' || kind === 'other') {
      current!.paragraphs.push(paragraph.index);
      continue;
    }
    if (kind === 'bio-beliefs' && !BULLET.test(text)) {
      (current ?? openSection('bio')).paragraphs.push(paragraph.index);
      continue;
    }
    if (kind === 'beliefs' && level !== undefined && text !== '') {
      group = text;
      run = undefined;
      proposal.structure.push(paragraph.index);
      continue;
    }
    if (!run) {
      run = [];
      beliefRuns.push(run);
    }
    run.push({ paragraph, group });
  }

  for (const entries of beliefRuns) {
    proposal.tabs.push(...splitBeliefs(entries, proposal.structure));
  }
  proposal.structure.sort((a, b) => a - b);

  const isTemplate = preamble.some((index) =>
    ONBOARDING_TEMPLATE.test(docx.paragraphs[index].text.trim()),
  );
  const drop = (paragraphs: number[], reason: string) => {
    if (paragraphs.length > 0) proposal.dropped.push({ paragraphs, reason });
  };
  drop(
    preamble,
    isTemplate
      ? ONBOARDING_REASON
      : 'Before the first section: title and navigation',
  );
  drop(legal, 'Legal section: not migrated (Tripp, plan §2b)');
  drop(placeholders, PLACEHOLDER_REASON);
  drop(separators, 'Separator lines');

  // Never a template asset (the same file in several members' pages, e.g. the
  // example picture in Tripp's onboarding template) and never a format the
  // converter cannot read (HEIC: the .docx export holds a JPEG copy instead).
  const photos = (pages?.dataFiles ?? []).filter(
    (file) =>
      file.image &&
      !file.thumbnail &&
      !UNREADABLE_IMAGE.test(file.path) &&
      !options.templateSha256?.has(file.sha256),
  );
  if (photos.length > 0) {
    proposal.images = {
      picture: photos[0].path,
      gallery: photos.slice(1).map((file) => file.path),
    };
  }
  return proposal;
}

export interface CommentPlacement {
  commentId: string;
  /** Tab index in `proposal.tabs`, when the highlight is in a belief. */
  tab?: number;
  /** The paragraph the comment is attached to, when it is placed in a section or tab. */
  paragraph?: number;
  /** Why it lands on the profile's "Imported comments" list instead. */
  unplaced?: 'not-anchored' | 'anchor-dropped' | 'anchor-in-heading';
  /** True when the highlight spans more than one tab (first tab wins). */
  spansTabs?: boolean;
}

export interface ProposalCheck {
  errors: string[];
  placements: CommentPlacement[];
  /**
   * Things that are valid but need a person's look before import: no belief
   * tabs, content dropped outside Legal, very long tabs, comments that could
   * not be placed or span tabs. A plausible split is not a correct one, so
   * these block the import until `reviewed` is set.
   */
  reviewFlags: string[];
}

/**
 * Validates a (possibly hand-edited) proposal against the documents it came
 * from, and decides where every comment goes. Any error refuses the import.
 */
export function checkProposal(
  proposal: ProfileProposal,
  docx: DocxDocument,
  pages?: PagesPackage,
): ProposalCheck {
  const errors: string[] = [];
  if (proposal.version !== PROPOSAL_VERSION) {
    errors.push(`Unsupported proposal version ${String(proposal.version)}.`);
  }
  if (!SLUG_PATTERN.test(proposal.slug) || proposal.slug.length > 80) {
    errors.push(`Slug "${proposal.slug}" is not a valid page address.`);
  }
  if (!proposal.displayName.trim()) errors.push('Display name is empty.');

  const owner = new Map<number, string>();
  const claim = (index: number, where: string) => {
    if (!docx.paragraphs[index]) {
      errors.push(`${where}: paragraph ${index} does not exist.`);
    } else if (owner.has(index)) {
      errors.push(
        `Paragraph ${index} is placed twice: ${owner.get(index)} and ${where}.`,
      );
    } else {
      owner.set(index, where);
    }
  };
  proposal.sections.forEach((section, at) =>
    section.paragraphs.forEach((index) =>
      claim(index, `section ${at + 1} (${section.section})`),
    ),
  );
  proposal.tabs.forEach((tab, at) => {
    if (!tab.title.trim() || tab.title.length > 120) {
      errors.push(`Tab ${at + 1} needs a title of 1–120 characters.`);
    }
    if (tab.paragraphs.length === 0) errors.push(`Tab ${at + 1} is empty.`);
    tab.paragraphs.forEach((index) => claim(index, `tab ${at + 1}`));
  });
  proposal.structure.forEach((index) => claim(index, 'a heading'));
  proposal.dropped.forEach((drop, at) => {
    if (!drop.reason.trim())
      errors.push(`Dropped group ${at + 1} has no reason.`);
    drop.paragraphs.forEach((index) => claim(index, `dropped group ${at + 1}`));
  });

  for (const paragraph of contentParagraphs(docx)) {
    if (!owner.has(paragraph.index)) {
      errors.push(
        `Paragraph ${paragraph.index} is not placed, dropped or a heading.`,
      );
    }
  }

  const available = new Set([
    ...(pages?.dataFiles ?? []).map((file) => file.path),
    ...docx.media.keys(),
  ]);
  for (const path of [
    ...(proposal.images.picture ? [proposal.images.picture] : []),
    ...proposal.images.gallery,
  ]) {
    if (!available.has(path)) errors.push(`Image ${path} is not in the files.`);
    else if (UNREADABLE_IMAGE.test(path)) {
      errors.push(
        `Image ${path} is HEIC, which cannot be converted: use the JPEG copy in the .docx (word/media/).`,
      );
    }
  }

  const tabOf = new Map<number, number>();
  proposal.tabs.forEach((tab, at) =>
    tab.paragraphs.forEach((index) => tabOf.set(index, at)),
  );
  const placed = new Set<number>(
    proposal.sections.flatMap((section) => section.paragraphs),
  );
  const structure = new Set(proposal.structure);

  const placements = docx.comments.map((comment): CommentPlacement => {
    if (!comment.anchored) {
      return { commentId: comment.id, unplaced: 'not-anchored' };
    }
    const tabs = [
      ...new Set(
        comment.paragraphIndices
          .filter((index) => tabOf.has(index))
          .map((index) => tabOf.get(index)!),
      ),
    ];
    if (tabs.length > 0) {
      const paragraph = comment.paragraphIndices.find(
        (index) => tabOf.get(index) === tabs[0],
      )!;
      return {
        commentId: comment.id,
        tab: tabs[0],
        paragraph,
        ...(tabs.length > 1 ? { spansTabs: true } : {}),
      };
    }
    const inSection = comment.paragraphIndices.find((index) =>
      placed.has(index),
    );
    if (inSection !== undefined) {
      return { commentId: comment.id, paragraph: inSection };
    }
    return {
      commentId: comment.id,
      unplaced: comment.paragraphIndices.some((index) => structure.has(index))
        ? 'anchor-in-heading'
        : 'anchor-dropped',
    };
  });

  const reviewFlags: string[] = [];
  if (proposal.tabs.length === 0) reviewFlags.push('No belief tabs.');
  for (const drop of proposal.dropped) {
    if (/^Legal/.test(drop.reason)) continue;
    const kept = drop.paragraphs.filter((index) => docx.paragraphs[index]);
    const characters = kept.reduce(
      (sum, index) => sum + docx.paragraphs[index].text.trim().length,
      0,
    );
    // A hint in parentheses could be the member's own aside: always look.
    if (
      kept.length > DROP_REVIEW_PARAGRAPHS ||
      drop.reason === PLACEHOLDER_REASON
    ) {
      reviewFlags.push(
        `${kept.length} paragraphs (${characters} characters) dropped: ${drop.reason}.`,
      );
    }
  }
  proposal.tabs.forEach((tab, at) => {
    if (tab.paragraphs.length > LONG_TAB_PARAGRAPHS) {
      reviewFlags.push(
        `Tab ${at + 1} ("${tab.title}") holds ${tab.paragraphs.length} paragraphs.`,
      );
    }
  });
  const unplaced = placements.filter((p) => p.unplaced).length;
  if (unplaced > 0) {
    reviewFlags.push(
      `${unplaced} comment(s) could not be placed on a paragraph.`,
    );
  }
  const spanning = placements.filter((p) => p.spansTabs).length;
  if (spanning > 0) {
    reviewFlags.push(`${spanning} comment(s) highlight text across tabs.`);
  }

  return { errors, placements, reviewFlags };
}
