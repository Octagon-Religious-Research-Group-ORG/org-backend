import { randomUUID } from 'node:crypto';
import type {
  BlockKind,
  BlockSection,
} from '../../social/schemas/profile-block.schema';
import type { ProfileVisibility } from '../../social/schemas/social-profile.schema';
import { legacyDate } from './docx-reader';
import type { DocxDocument, DocxParagraph } from './docx-reader';
import {
  type CommentPlacement,
  isLegalDrop,
  type ProfileProposal,
} from './proposal';

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
  anonymous: boolean;
  tabs: PlannedTab[];
  blocks: PlannedBlock[];
  comments: PlannedComment[];
  /** Package paths, picture first. */
  images: { path: string; role: 'picture' | 'gallery' }[];
  /** Every link that still points at Apple Pages after rewriting. */
  unmappedPagesLinks: string[];
  /** Addresses removed as unsafe; the link's visible text is kept. */
  unsafeLinks: string[];
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

/** Anywhere in a paragraph, so a mistyped or plain-text Pages link is still seen. */
const PAGES_URL = /[^\s)\]"'<>]*icloud\.com\/pages\/[^\s)\]"'<>]*/gi;
const PAGES_ADDRESS = /icloud\.com\/pages\//i;

/** Only these may become a clickable address. */
const SAFE_LINK = /^(?:https?:|mailto:)/i;

/** Markdown-escapes the characters that would break a `[text](url)` link. */
function escapeText(text: string): string {
  return text.replace(/([\\[\]])/g, '\\$1');
}

/**
 * A paragraph's text with its links written as Markdown, each at the position
 * the reader recorded (searching for the label breaks when two links share
 * one, or a label also appears in plain text). Links between migrated profiles
 * become site addresses (`/some-member`); other iCloud links are kept and reported,
 * since they break when the Pages documents are retired. An address that is
 * not http(s) or mailto is dropped, keeping the words, and reported in `unsafe`.
 */
export function paragraphMarkdown(
  paragraph: DocxParagraph,
  slugByPagesKey: ReadonlyMap<string, string>,
  unmapped: string[],
  unsafe: string[] = [],
): string {
  for (const [url] of paragraph.text.matchAll(PAGES_URL)) {
    unmapped.push(url.replace(/[.,;:!?]+$/, ''));
  }
  const text = paragraph.text.trim();
  const lead = paragraph.text.length - paragraph.text.trimStart().length;
  const links = [...paragraph.links].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  const leftover: string[] = [];
  for (const link of links) {
    const key = pagesKey(link.url);
    const slug = key ? slugByPagesKey.get(key) : undefined;
    if (!slug && PAGES_ADDRESS.test(link.url)) unmapped.push(link.url);
    if (!link.text) continue;
    const label = escapeText(link.text);
    const safe = slug !== undefined || SAFE_LINK.test(link.url);
    if (!safe) unsafe.push(link.url);
    const target = (slug ? `/${slug}` : link.url).replace(/\)/g, '%29');
    const written = safe ? `[${label}](${target})` : label;
    const at = link.start - lead;
    if (at >= cursor && text.slice(at, at + link.text.length) === link.text) {
      out += `${escapeText(text.slice(cursor, at))}${written}`;
      cursor = at + link.text.length;
    } else {
      leftover.push(written);
    }
  }
  return [`${out}${escapeText(text.slice(cursor))}`, ...leftover].join(' ');
}

/** The typed or numbered label at the start of a paragraph, e.g. "II." or "A.". */
function labelOf(paragraph: DocxParagraph): string {
  if (paragraph.numbering) return paragraph.numbering.label.slice(0, 20);
  return (
    /^\s*((?:[IVXLC]+|[A-Za-z]|\d+)[.)])\s/.exec(paragraph.text)?.[1] ?? ''
  );
}

/**
 * A paragraph's pictures and text pieces in document order: a picture between
 * two runs splits the text around it. A picture inside a link's words moves to
 * the end of the link, so one link is never cut in two.
 */
function inDocumentOrder(paragraph: DocxParagraph): (string | DocxParagraph)[] {
  const { text, links, images } = paragraph;
  const end = text.trimEnd().length;
  const offsets = paragraph.imageOffsets ?? images.map(() => end);
  const pieces: (string | { from: number; to: number })[] = [];
  let cursor = text.length - text.trimStart().length;
  offsets.forEach((offset, at) => {
    const link = links.find(
      (l) => offset > l.start && offset < l.start + l.text.length,
    );
    const position = Math.max(
      cursor,
      Math.min(end, link ? link.start + link.text.length : offset),
    );
    if (text.slice(cursor, position).trim()) {
      pieces.push({ from: cursor, to: position });
    }
    cursor = position;
    pieces.push(images[at]);
  });
  if (text.slice(cursor, end).trim()) pieces.push({ from: cursor, to: end });

  const ranges = pieces.filter((piece) => typeof piece !== 'string');
  return pieces.map((piece) => {
    if (typeof piece === 'string') return piece;
    if (ranges.length === 1) return paragraph;
    const isFirst = piece === ranges[0];
    const isLast = piece === ranges[ranges.length - 1];
    return {
      ...paragraph,
      text: text.slice(piece.from, piece.to),
      links: links
        .filter(
          (l) =>
            (isFirst || l.start >= piece.from) &&
            (isLast || l.start < piece.to),
        )
        .map((l) => ({ ...l, start: l.start - piece.from })),
    };
  });
}

function kindOf(paragraph: DocxParagraph): BlockKind {
  if (paragraph.text.trim() === '' && paragraph.images.length > 0) {
    return 'image';
  }
  if (paragraph.headingLevel !== undefined) return 'heading';
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
  const unsafe: string[] = [];
  const legalParagraphs = new Set(
    proposal.dropped.filter(isLegalDrop).flatMap((drop) => drop.paragraphs),
  );
  const blocks: PlannedBlock[] = [];
  const blockOf = new Map<number, string>();
  const orderIn = new Map<string, number>();

  const add = (index: number, section: BlockSection, tabId?: string) => {
    const paragraph = docx.paragraphs[index];
    const key = tabId ?? section;
    const emit = (kind: BlockKind, text: string): PlannedBlock => {
      const order = orderIn.get(key) ?? 0;
      orderIn.set(key, order + 1);
      const block: PlannedBlock = {
        blockId: ids('blk'),
        section,
        kind,
        label: kind === 'outline-item' ? labelOf(paragraph) : '',
        order,
        ...(tabId ? { tabId } : {}),
        text,
        paragraph: index,
      };
      blocks.push(block);
      return block;
    };

    // One block per picture, in place among the paragraph's text. A comment on
    // the paragraph anchors to its first text, or its first picture if none.
    const kind = kindOf(paragraph);
    if (kind === 'image') {
      blockOf.set(index, emit('image', paragraph.images[0]).blockId);
      for (const image of paragraph.images.slice(1)) emit('image', image);
      return;
    }
    let anchored = false;
    for (const piece of inDocumentOrder(paragraph)) {
      if (typeof piece === 'string') {
        emit('image', piece);
        continue;
      }
      const block = emit(
        anchored ? 'paragraph' : kind,
        paragraphMarkdown(piece, slugByPagesKey, unmapped, unsafe),
      );
      if (!anchored) blockOf.set(index, block.blockId);
      anchored = true;
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
    const date = comment.date ? legacyDate(comment.date) : undefined;
    // A highlight on the Legal section must not carry its words over (§2b).
    const onLegal = comment.paragraphIndices.some((index) =>
      legalParagraphs.has(index),
    );
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
      ...(comment.anchorText && !onLegal
        ? { anchorText: comment.anchorText }
        : {}),
      legacyAuthorName: comment.author.trim() || 'Unknown (Apple Pages)',
      ...(date ? { legacyCreatedAt: date } : {}),
      body: comment.text,
      placement,
    };
  });

  return {
    slug: proposal.slug,
    displayName: proposal.displayName,
    pagesUrl: proposal.pagesUrl,
    visibility: proposal.visibility,
    anonymous: proposal.anonymous ?? false,
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
    unsafeLinks: [...new Set(unsafe)].sort(),
  };
}
