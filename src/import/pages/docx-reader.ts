import type { Element } from '@xmldom/xmldom';
import { strFromU8 } from 'fflate';
import { DocxNumbering } from './docx-numbering';
import { attr, children, firstChild, parseXml, textOf } from './xml';
import { safeUnzip } from './zip-safe';

export interface DocxLink {
  text: string;
  url: string;
  /** Where `text` starts in the paragraph's untrimmed text. */
  start: number;
}

export interface DocxParagraph {
  /** Position among all paragraphs of the body, tables included. */
  index: number;
  /** Style name as Word shows it, e.g. "Heading 2", "Body". */
  style: string;
  /** 1–9 for "Heading N", 0 for "Title", undefined otherwise. */
  headingLevel?: number;
  /** Real Word list numbering; the label is what Word would display. */
  numbering?: { numId: string; level: number; label: string };
  text: string;
  links: DocxLink[];
  /** Package paths of embedded images, e.g. "word/media/image1.png". */
  images: string[];
  /**
   * Where each of `images` sits in the untrimmed text, set only when a picture
   * has text after it. Absent means every picture follows the text.
   */
  imageOffsets?: number[];
  inTable: boolean;
}

export interface DocxComment {
  id: string;
  author: string;
  /** As recorded by the exporting app; not proof of when it was written. */
  date?: string;
  text: string;
  /** Id of the comment this one replies to (Word 2012+ `commentsExtended`). */
  parentId?: string;
  /** The highlighted text, paragraphs joined by "\n"; "" if never anchored. */
  anchorText: string;
  /** Paragraph indices the highlight touches. */
  paragraphIndices: number[];
  anchored: boolean;
}

export interface DocxDocument {
  paragraphs: DocxParagraph[];
  comments: DocxComment[];
  media: Map<string, Uint8Array>;
  /**
   * Things the reader saw but could not interpret. The importer reports every
   * one: a warning is "cannot measure", never silently "fine".
   */
  warnings: string[];
}

interface Relationship {
  target: string;
  external: boolean;
}

interface FieldState {
  instr: string;
  result: string;
  phase: 'instr' | 'result';
  /** Length of the paragraph's text when the field began. */
  start: number;
  /** How many pictures the paragraph held when the field began. */
  images: number;
}

const HYPERLINK_INSTR = /^\s*HYPERLINK\s+(?:\\l\s+)?"([^"]*)"/;

/** The paragraph a warning is about, or undefined for a whole-document one. */
export function warningParagraph(warning: string): number | undefined {
  const match = /^Paragraph (\d+):/.exec(warning);
  return match ? Number(match[1]) : undefined;
}

/** Block-level containers whose paragraphs are not part of the document. */
const NOT_CONTENT = new Set(['w:sectPr', 'w:del', 'w:moveFrom']);

const LEGACY_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Reads a date as recorded by the exporting app, or undefined if it is not a
 * real date. A date with no timezone is taken as UTC, never as this machine's
 * local time: the same file must give the same record on every machine.
 */
export function legacyDate(value: string): Date | undefined {
  const match = LEGACY_DATE.exec(value);
  if (!match) return undefined;
  const hasTime = value.includes('T');
  const date = new Date(hasTime && !match[4] ? `${value}Z` : value);
  if (Number.isNaN(date.getTime())) return undefined;
  // Date rolls "02-30" over to March instead of rejecting it.
  const [year, month, day] = [match[1], match[2], match[3]].map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return calendar.getUTCMonth() === month - 1 ? date : undefined;
}

/**
 * Reads a .docx exported by Apple Pages (or Word) into plain, ordered data:
 * paragraphs with style, numbering, links and images, plus every comment with
 * its author, date, reply parent and the exact text it highlights.
 *
 * Lossless where it matters for the import: tracked deletions are excluded,
 * insertions kept, field codes (Pages writes links as HYPERLINK fields) are
 * read for their URL and never leak into the text.
 *
 * @throws Error when the file is not a zip or has no word/document.xml
 */
export function readDocx(bytes: Uint8Array): DocxDocument {
  const files = safeUnzip(bytes, '.docx');
  const part = (path: string) =>
    files[path] ? parseXml(strFromU8(files[path]), path) : undefined;

  const body = firstChild(part('word/document.xml'), 'w:body');
  if (!body) throw new Error('The .docx has no word/document.xml body.');

  const warnings: string[] = [];
  const relationships = readRelationships(part('word/_rels/document.xml.rels'));
  const styleNames = readStyleNames(part('word/styles.xml'));
  const numberedStyles = readNumberedStyles(part('word/styles.xml'));
  const numbering = new DocxNumbering(part('word/numbering.xml'));
  const comments = readComments(
    part('word/comments.xml'),
    part('word/commentsExtended.xml'),
    warnings,
  );

  // `start` is only a fallback: a highlight that covers no text still belongs
  // to the paragraph it was placed in.
  const anchors = new Map<
    string,
    { text: string; paragraphs: Set<number>; start: number }
  >();
  const open = new Set<string>();
  const paragraphs: DocxParagraph[] = [];

  const visitParagraph = (p: Element, inTable: boolean) => {
    const index = paragraphs.length;
    const pPr = firstChild(p, 'w:pPr');
    const styleId = attr(firstChild(pPr, 'w:pStyle'), 'w:val') ?? '';
    const style = styleNames.get(styleId) ?? styleId;
    const paragraph: DocxParagraph = {
      index,
      style,
      headingLevel: headingLevelOf(style),
      text: '',
      links: [],
      images: [],
      inTable,
    };

    const numPr = firstChild(pPr, 'w:numPr');
    const numId = attr(firstChild(numPr, 'w:numId'), 'w:val');
    // Held until the paragraph is read: an empty numbered line loses nothing.
    const numberingWarnings: string[] = [];
    if (numId === undefined && numberedStyles.has(styleId)) {
      // The label cannot be worked out here, and a belief outline without its
      // labels splits wrongly: stop and look rather than import it label-less.
      numberingWarnings.push(
        `Paragraph ${index}: numbering comes from its style, which is not supported.`,
      );
    }
    if (numId && numId !== '0') {
      const level = Number(attr(firstChild(numPr, 'w:ilvl'), 'w:val') ?? 0);
      const label = numbering.next(numId, level);
      if (label === undefined) {
        numberingWarnings.push(
          `Paragraph ${index}: list ${numId} level ${level} is not defined in numbering.xml.`,
        );
      } else {
        paragraph.numbering = { numId, level, label };
      }
    }

    // A highlight that continues from the previous paragraph gets a line break.
    for (const id of open) {
      const anchor = anchors.get(id)!;
      if (anchor.text) anchor.text += '\n';
    }

    const imageOffsets: number[] = [];
    const fields: FieldState[] = [];
    const emit = (text: string) => {
      if (fields.some((field) => field.phase === 'instr')) return;
      paragraph.text += text;
      for (const field of fields) field.result += text;
      for (const id of open) {
        const anchor = anchors.get(id)!;
        anchor.text += text;
        // Only text counts: a highlight that starts at the very end of one
        // paragraph and covers the next one is a comment on the next one.
        if (text.trim()) anchor.paragraphs.add(index);
      }
    };
    const pictureLink = () =>
      warnings.push(
        `Paragraph ${index}: a link on a picture cannot be kept, only the picture.`,
      );
    const addLink = (field: FieldState, url: string) => {
      if (
        field.result.trim() === '' &&
        paragraph.images.length > field.images
      ) {
        pictureLink();
      }
      const leading = field.result.length - field.result.trimStart().length;
      paragraph.links.push({
        text: field.result.trim(),
        url,
        start: field.start + leading,
      });
    };
    const endField = (field: FieldState) => {
      const url = HYPERLINK_INSTR.exec(field.instr)?.[1];
      if (url !== undefined) addLink(field, url);
    };
    const image = (relationshipId: string | undefined) => {
      const relationship = relationshipId
        ? relationships.get(relationshipId)
        : undefined;
      if (!relationship || relationship.external) {
        warnings.push(
          `Paragraph ${index}: image ${relationshipId ?? '(no id)'} has no embedded file.`,
        );
        return;
      }
      paragraph.images.push(relationship.target);
      imageOffsets.push(paragraph.text.length);
    };

    const walk = (node: Element) => {
      for (const child of children(node)) {
        switch (child.nodeName) {
          case 'w:pPr':
          case 'w:rPr':
          case 'w:del':
          case 'w:delText':
          case 'w:moveFrom':
            break;
          case 'w:t':
            emit(textOf(child));
            break;
          case 'w:tab':
            emit('\t');
            break;
          case 'w:br':
          case 'w:cr':
            emit('\n');
            break;
          case 'w:noBreakHyphen':
            emit('-');
            break;
          case 'w:commentRangeStart': {
            const id = attr(child, 'w:id') ?? '';
            open.add(id);
            if (!anchors.has(id)) {
              anchors.set(id, {
                text: '',
                paragraphs: new Set(),
                start: index,
              });
            }
            break;
          }
          case 'w:commentRangeEnd':
            open.delete(attr(child, 'w:id') ?? '');
            break;
          case 'w:fldChar': {
            const type = attr(child, 'w:fldCharType');
            if (type === 'begin') {
              fields.push({
                instr: '',
                result: '',
                phase: 'instr',
                start: paragraph.text.length,
                images: paragraph.images.length,
              });
            } else if (type === 'separate' && fields.length > 0) {
              fields[fields.length - 1].phase = 'result';
            } else if (type === 'end' && fields.length > 0) {
              endField(fields.pop()!);
            }
            break;
          }
          case 'w:instrText':
            if (fields.length > 0) {
              fields[fields.length - 1].instr += textOf(child);
            }
            break;
          case 'w:fldSimple': {
            const field: FieldState = {
              instr: attr(child, 'w:instr') ?? '',
              result: '',
              phase: 'result',
              start: paragraph.text.length,
              images: paragraph.images.length,
            };
            fields.push(field);
            walk(child);
            fields.pop();
            endField(field);
            break;
          }
          case 'w:hyperlink': {
            const relationship = relationships.get(attr(child, 'r:id') ?? '');
            const anchor = attr(child, 'w:anchor');
            const field: FieldState = {
              instr: '',
              result: '',
              phase: 'result',
              start: paragraph.text.length,
              images: paragraph.images.length,
            };
            fields.push(field);
            walk(child);
            fields.pop();
            const url = relationship?.target ?? (anchor ? `#${anchor}` : '');
            if (url) addLink(field, url);
            break;
          }
          case 'a:hlinkClick':
            if (attr(child, 'r:id')) pictureLink();
            break;
          case 'w:footnoteReference':
          case 'w:endnoteReference':
            warnings.push(
              `Paragraph ${index}: a footnote or endnote cannot be imported.`,
            );
            break;
          case 'w:sym':
            warnings.push(
              `Paragraph ${index}: a symbol-font character cannot be imported.`,
            );
            break;
          case 'a:blip':
            image(attr(child, 'r:embed'));
            break;
          case 'v:imagedata':
            image(attr(child, 'r:id'));
            break;
          case 'mc:AlternateContent': {
            // Choice and Fallback describe the same content twice.
            const choice = firstChild(child, 'mc:Choice');
            if (choice) walk(choice);
            break;
          }
          default:
            walk(child);
        }
      }
    };
    walk(p);
    if (paragraph.text.trim() !== '' || paragraph.images.length > 0) {
      warnings.push(...numberingWarnings);
    }
    const textEnd = paragraph.text.trimEnd().length;
    if (textEnd > 0 && imageOffsets.some((offset) => offset < textEnd)) {
      paragraph.imageOffsets = imageOffsets;
    }
    paragraphs.push(paragraph);
  };

  const visitBlock = (node: Element, inTable: boolean) => {
    for (const child of children(node)) {
      if (child.nodeName === 'w:p') visitParagraph(child, inTable);
      else if (child.nodeName === 'w:tbl') visitBlock(child, true);
      // Whole paragraphs inside w:del / w:moveFrom were deleted or moved away.
      else if (!NOT_CONTENT.has(child.nodeName)) visitBlock(child, inTable);
    }
  };
  visitBlock(body, false);

  for (const id of open) {
    warnings.push(`Comment ${id}: highlight starts but never ends.`);
  }
  for (const comment of comments) {
    const anchor = anchors.get(comment.id);
    if (anchor) {
      comment.anchored = true;
      comment.anchorText = anchor.text;
      comment.paragraphIndices =
        anchor.paragraphs.size > 0
          ? [...anchor.paragraphs].sort((a, b) => a - b)
          : [anchor.start];
    }
  }
  for (const id of anchors.keys()) {
    if (!comments.some((comment) => comment.id === id)) {
      warnings.push(`Highlight ${id} has no matching comment in comments.xml.`);
    }
  }

  const media = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(files)) {
    if (path.startsWith('word/media/')) media.set(path, data);
  }

  return { paragraphs, comments, media, warnings };
}

/** Visible text of a comment paragraph: text, tabs and line breaks only. */
function plainText(node: Element): string {
  let out = '';
  for (const child of children(node)) {
    if (child.nodeName === 'w:t') out += textOf(child);
    else if (child.nodeName === 'w:tab') out += '\t';
    else if (child.nodeName === 'w:br' || child.nodeName === 'w:cr')
      out += '\n';
    else if (child.nodeName !== 'w:delText' && child.nodeName !== 'w:instrText')
      out += plainText(child);
  }
  return out;
}

function headingLevelOf(style: string): number | undefined {
  if (/^title$/i.test(style)) return 0;
  const match = /^heading\s*([1-9])$/i.exec(style);
  return match ? Number(match[1]) : undefined;
}

/** Styles that number their paragraphs, directly or through `w:basedOn`. */
function readNumberedStyles(root?: Element): Set<string> {
  const styles = new Map(
    (root ? children(root, 'w:style') : []).map((style) => [
      attr(style, 'w:styleId') ?? '',
      {
        numId: attr(
          firstChild(
            firstChild(firstChild(style, 'w:pPr'), 'w:numPr'),
            'w:numId',
          ),
          'w:val',
        ),
        basedOn: attr(firstChild(style, 'w:basedOn'), 'w:val'),
      },
    ]),
  );
  const numbered = new Set<string>();
  for (const id of styles.keys()) {
    const seen = new Set<string>();
    let at: string | undefined = id;
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      const style = styles.get(at);
      if (style?.numId !== undefined) {
        if (style.numId !== '0') numbered.add(id);
        break;
      }
      at = style?.basedOn;
    }
  }
  return numbered;
}

function readRelationships(root?: Element): Map<string, Relationship> {
  const out = new Map<string, Relationship>();
  for (const rel of root ? children(root, 'Relationship') : []) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (!id || target === undefined) continue;
    const external = attr(rel, 'TargetMode') === 'External';
    out.set(id, {
      external,
      target: external ? target : `word/${target.replace(/^\/?(word\/)?/, '')}`,
    });
  }
  return out;
}

function readStyleNames(root?: Element): Map<string, string> {
  const out = new Map<string, string>();
  for (const style of root ? children(root, 'w:style') : []) {
    const id = attr(style, 'w:styleId');
    const name = attr(firstChild(style, 'w:name'), 'w:val');
    if (id && name) out.set(id, name);
  }
  return out;
}

function readComments(
  commentsRoot: Element | undefined,
  extendedRoot: Element | undefined,
  warnings: string[],
): DocxComment[] {
  const comments: DocxComment[] = [];
  const idByParaId = new Map<string, string>();
  const lastParaIdOf = new Map<string, string>();
  const seenIds = new Set<string>();

  for (const element of commentsRoot
    ? children(commentsRoot, 'w:comment')
    : []) {
    const id = attr(element, 'w:id') ?? '';
    if (seenIds.has(id)) {
      warnings.push(`Comment ${id} appears more than once in comments.xml.`);
    }
    seenIds.add(id);
    const date = attr(element, 'w:date');
    if (date !== undefined && legacyDate(date) === undefined) {
      warnings.push(`Comment ${id}: its date is not a valid date.`);
    }
    const text = children(element, 'w:p').map(plainText).join('\n').trim();
    for (const p of children(element, 'w:p')) {
      const paraId = attr(p, 'w14:paraId');
      if (paraId) {
        idByParaId.set(paraId, id);
        lastParaIdOf.set(id, paraId);
      }
    }
    comments.push({
      id,
      author: attr(element, 'w:author') ?? '',
      date,
      text,
      anchorText: '',
      paragraphIndices: [],
      anchored: false,
    });
  }

  for (const entry of extendedRoot
    ? children(extendedRoot, 'w15:commentEx')
    : []) {
    const parentParaId = attr(entry, 'w15:paraIdParent');
    if (!parentParaId) continue;
    const childId = idByParaId.get(attr(entry, 'w15:paraId') ?? '');
    const parentId = idByParaId.get(parentParaId);
    const comment = comments.find((candidate) => candidate.id === childId);
    if (!comment || parentId === undefined) {
      warnings.push(
        `A reply in commentsExtended.xml points at a comment that does not exist (${parentParaId}).`,
      );
      continue;
    }
    // Only the comment's LAST paragraph identifies it in commentsExtended.
    if (lastParaIdOf.get(comment.id) === attr(entry, 'w15:paraId')) {
      comment.parentId = parentId;
    }
  }
  return comments;
}
