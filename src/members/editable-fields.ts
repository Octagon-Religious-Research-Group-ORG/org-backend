import {
  cleanMemberParagraphs,
  cleanMemberTitle,
} from '../membership/member-text';
import { splitParagraphs } from '../membership/membership.service';

/**
 * How the editable parts of a member page map onto blocks (Chunk 8).
 *
 * A field is the bio, one belief's text, or one belief's title. Each field's
 * history is ONE chain of versions, so a save is one version and an editor's
 * starting point is one number:
 * - text: the field's first text block. Pages written before editing existed
 *   keep one block per paragraph; the first edit writes the whole text as a
 *   new version of the first block and takes the others off the page. Their
 *   versions stay, and the history shows them as parts of the earlier text.
 * - title: a block of its own in the `tab-title` section, which no page read
 *   ever shows; the tab row keeps the current title.
 */

/** Author of the first title version: the title as it stood before editing. */
export const TITLE_RECORD_AUTHOR = 'system:title-before-history';

/** Author of migrated text (kept in step with the importer). */
export const IMPORTED_AUTHOR = 'system:import';

/** One title history per tab; a fixed id makes two first edits collide. */
export function titleBlockId(tabId: string): string {
  return `ttl_${tabId}`;
}

/** The text block a field gets when it has none; fixed for the same reason. */
export function firstTextBlockId(field: 'bio' | 'tab', key: string): string {
  return field === 'bio' ? `bio_${key}` : `txt_${key}`;
}

export interface FieldBlockText {
  label?: string;
  text: string;
}

/**
 * The text an editor starts from: each block on its own paragraph, an
 * imported outline label kept in front of its text.
 */
export function editorText(blocks: readonly FieldBlockText[]): string {
  return blocks
    .map((block) => (block.label ? `${block.label} ${block.text}` : block.text))
    .join('\n\n');
}

/**
 * A text box as it is stored: the member-text rules, then the paragraphs
 * joined by exactly one blank line. Two texts that read the same compare
 * equal here, so saving one over the other is no change.
 */
export function normaliseFieldText(raw: string): string {
  return splitParagraphs(cleanMemberParagraphs(raw)).join('\n\n');
}

export function normaliseTitle(raw: string): string {
  return cleanMemberTitle(raw);
}

/** Where a version came from, for the history label. Never the author id. */
export type VersionSource = 'member' | 'imported' | 'title-before-history';

export function versionSource(authorUserId: string): VersionSource {
  if (authorUserId === IMPORTED_AUTHOR) return 'imported';
  if (authorUserId === TITLE_RECORD_AUTHOR) return 'title-before-history';
  return 'member';
}

/**
 * Did this version hold the field's whole text? Yes for any version of a
 * field that only ever had one block, and for every edit (seq > 1) of its
 * first block, since an edit always writes the whole text there. A version of
 * any other block, or the first version of the first block of a field that
 * had several, is one paragraph of the text from before the first edit.
 *
 * @param fieldBlockIds - every block the field ever had, first block first
 */
export function holdsWholeText(
  version: { blockId: string; seq: number },
  fieldBlockIds: readonly string[],
): boolean {
  if (fieldBlockIds.length === 1) return true;
  return version.blockId === fieldBlockIds[0] && version.seq > 1;
}
