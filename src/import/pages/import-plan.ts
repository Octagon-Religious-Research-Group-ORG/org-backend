import { randomUUID } from 'node:crypto';
import type {
  BlockKind,
  BlockSection,
} from '../../social/schemas/profile-block.schema';
import type { ProfileVisibility } from '../../social/schemas/social-profile.schema';
import type { DocxDocument, DocxParagraph } from './docx-reader';
import type { CommentPlacement, ProfileProposal } from './proposal';

/**
 * Who wrote imported text. Versions authored by the import are labelled so in
 * the UI ("imported from Apple Pages; originally written before <date>",
 * plan §6): the import date is the only date we can prove.
 */
export const IMPORT_AUTHOR = 'system:import';

export interface PlannedBlock {
  blockId: string;
  section: BlockSection;
  kind: BlockKind;
  label: string;
  order: number;
  tabId?: string;
  /** Text with links as Markdown `[text](url)`; for an image, its package path. */
  text: string;
  /** The .docx paragraph this block came from. */
  paragraph: number;
}

export interface PlannedTab {
  tabId: string;
  title: string;
  group?: string;
  order: number;
}

export interface PlannedComment {
  commentId: string;
  parentCommentId?: string;
  tabId?: string;
  anchorBlockId?: string;
  anchorText?: string;
  legacyAuthorName: string;
  legacyCreatedAt?: Date;
  body: string;
  placement: CommentPlacement;
}

export interface ImportPlan {
  slug: string;
  displayName: string;
  pagesUrl: string;
  visibility: ProfileVisibility;
  tabs: PlannedTab[];
  blocks: PlannedBlock[];
  comments: PlannedComment[];
  /** Package paths, picture first. */
  images: { path: string; role: 'picture' | 'gallery' }[];
  /** Every link that still points at Apple Pages after rewriting. */
  unmappedPagesLinks: string[];
}

export type IdFactory = (prefix: 'tab' | 'blk' | 'cmt') => string;

export const randomIds: IdFactory = (prefix) => `${prefix}_${randomUUID()}`;

/** The document part of an iCloud Pages link, for matching between profiles. */
export function pagesKey(url: string): string | undefined {
  const match =
    /^https?:\/\/(?:www\.)?icloud\.com\/pages\/([A-Za-z0-9_-]+)/i.exec(
      url.trim(),
    );
  return match?.[1];
}

/** Markdown-escapes the characters that would break a `[text](url)` link. */
function escapeText(text: string): string {
  return text.replace(/([\\[\]])/g, '\\$1');
}

/**
 * A paragraph's text with its links written as Markdown. Links between
 * migrated profiles become site addresses (`/tripp`); other iCloud links are
 * kept and reported, since they break when the Pages documents are retired.
 */
export function paragraphMarkdown(
  paragraph: DocxParagraph,
  slugByPagesKey: ReadonlyMap<string, string>,
  unmapped: string[],
): string {
  let text = escapeText(paragraph.text.trim());
  for (const link of paragraph.links) {
    const key = pagesKey(link.url);
    const slug = key ? slugByPagesKey.get(key) : undefined;
    if (key && !slug) unmapped.push(link.url);
    const target = (slug ? `/${slug}` : link.url).replace(/\)/g, '%29');
    const label = escapeText(link.text);
    if (!label) continue;
    const at = text.indexOf(label);
    if (at >= 0) {
      text = `${text.slice(0, at)}[${label}](${target})${text.slice(at + label.length)}`;
    } else {
      text = `${text} [${label}](${target})`;
    }
  }
  return text;
}

/** The typed or numbered label at the start of a paragraph, e.g. "II." or "A.". */
function labelOf(paragraph: DocxParagraph): string {
  if (paragraph.numbering) return paragraph.numbering.label.slice(0, 20);
  return (
    /^\s*((?:[IVXLC]+|[A-Za-z]|\d+)[.)])\s/.exec(paragraph.text)?.[1] ?? ''
  );
}

function kindOf(paragraph: DocxParagraph): BlockKind {
  if (paragraph.headingLevel !== undefined) return 'heading';
  if (paragraph.text.trim() === '' && paragraph.images.length > 0) {
    return 'image';
  }
  return labelOf(paragraph) ? 'outline-item' : 'paragraph';
}

/**
 * Turns a checked proposal into the exact rows to write. Pure: ids come from
 * `ids`, so tests are deterministic and a dry run shows what would be written.
 *
 * @param placements - from `checkProposal`, which must have returned no errors
 */
export function buildImportPlan(
  proposal: ProfileProposal,
  docx: DocxDocument,
  placements: CommentPlacement[],
  slugByPagesKey: ReadonlyMap<string, string>,
  ids: IdFactory = randomIds,
): ImportPlan {
  const unmapped: string[] = [];
  const blocks: PlannedBlock[] = [];
  const blockOf = new Map<number, string>();
  const orderIn = new Map<string, number>();

  const add = (
    index: number,
    section: BlockSection,
    tabId?: string,
    override?: Partial<PlannedBlock>,
  ) => {
    const paragraph = docx.paragraphs[index];
    const key = tabId ?? section;
    const order = orderIn.get(key) ?? 0;
    orderIn.set(key, order + 1);
    const kind = kindOf(paragraph);
    const block: PlannedBlock = {
      blockId: ids('blk'),
      section,
      kind,
      label: kind === 'outline-item' ? labelOf(paragraph) : '',
      order,
      ...(tabId ? { tabId } : {}),
      text:
        kind === 'image'
          ? paragraph.images[0]
          : paragraphMarkdown(paragraph, slugByPagesKey, unmapped),
      paragraph: index,
      ...override,
    };
    blocks.push(block);
    blockOf.set(index, block.blockId);
    // An image paragraph with several pictures becomes one block per picture.
    if (kind === 'image') {
      for (const extra of paragraph.images.slice(1)) {
        const order2 = orderIn.get(key)!;
        orderIn.set(key, order2 + 1);
        blocks.push({
          ...block,
          blockId: ids('blk'),
          order: order2,
          text: extra,
        });
      }
    }
  };

  for (const section of proposal.sections) {
    if (section.heading) {
      const order = orderIn.get(section.section) ?? 0;
      orderIn.set(section.section, order + 1);
      blocks.push({
        blockId: ids('blk'),
        section: section.section,
        kind: 'heading',
        label: '',
        order,
        text: escapeText(section.heading),
        paragraph: -1,
      });
    }
    for (const index of section.paragraphs) add(index, section.section);
  }

  const tabs = proposal.tabs.map(
    (tab, order): PlannedTab => ({
      tabId: ids('tab'),
      title: tab.title,
      ...(tab.group ? { group: tab.group } : {}),
      order,
    }),
  );
  proposal.tabs.forEach((tab, at) => {
    for (const index of tab.paragraphs) add(index, 'beliefs', tabs[at].tabId);
  });

  const commentIdOf = new Map<string, string>();
  for (const comment of docx.comments) commentIdOf.set(comment.id, ids('cmt'));
  const placementOf = new Map(placements.map((p) => [p.commentId, p]));

  const comments = docx.comments.map((comment): PlannedComment => {
    const placement = placementOf.get(comment.id) ?? {
      commentId: comment.id,
      unplaced: 'not-anchored' as const,
    };
    const date = comment.date ? new Date(comment.date) : undefined;
    return {
      commentId: commentIdOf.get(comment.id)!,
      ...(comment.parentId && commentIdOf.has(comment.parentId)
        ? { parentCommentId: commentIdOf.get(comment.parentId) }
        : {}),
      ...(placement.tab !== undefined
        ? { tabId: tabs[placement.tab].tabId }
        : {}),
      ...(placement.paragraph !== undefined && blockOf.has(placement.paragraph)
        ? { anchorBlockId: blockOf.get(placement.paragraph) }
        : {}),
      ...(comment.anchorText ? { anchorText: comment.anchorText } : {}),
      legacyAuthorName: comment.author.trim() || 'Unknown (Apple Pages)',
      ...(date && !Number.isNaN(date.getTime())
        ? { legacyCreatedAt: date }
        : {}),
      body: comment.text,
      placement,
    };
  });

  return {
    slug: proposal.slug,
    displayName: proposal.displayName,
    pagesUrl: proposal.pagesUrl,
    visibility: proposal.visibility,
    tabs,
    blocks,
    comments,
    images: [
      ...(proposal.images.picture
        ? [{ path: proposal.images.picture, role: 'picture' as const }]
        : []),
      ...proposal.images.gallery.map((path) => ({
        path,
        role: 'gallery' as const,
      })),
    ],
    unmappedPagesLinks: [...new Set(unmapped)].sort(),
  };
}
