import type { Element } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';
import { DocxNumbering } from './docx-numbering';
import { attr, children, firstChild, parseXml, textOf } from './xml';

export interface DocxLink {
  text: string;
  url: string;
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
}

const HYPERLINK_INSTR = /^\s*HYPERLINK\s+(?:\\l\s+)?"([^"]*)"/;

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
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    throw new Error(`Not a .docx (zip) file: ${(error as Error).message}`);
  }
  const part = (path: string) =>
    files[path] ? parseXml(strFromU8(files[path]), path) : undefined;

  const body = firstChild(part('word/document.xml'), 'w:body');
  if (!body) throw new Error('The .docx has no word/document.xml body.');

  const warnings: string[] = [];
  const relationships = readRelationships(part('word/_rels/document.xml.rels'));
  const styleNames = readStyleNames(part('word/styles.xml'));
  const numbering = new DocxNumbering(part('word/numbering.xml'));
  const comments = readComments(
    part('word/comments.xml'),
    part('word/commentsExtended.xml'),
    warnings,
  );

  const anchors = new Map<string, { text: string; paragraphs: Set<number> }>();
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
    if (numId && numId !== '0') {
      const level = Number(attr(firstChild(numPr, 'w:ilvl'), 'w:val') ?? 0);
      const label = numbering.next(numId, level);
      if (label === undefined) {
        warnings.push(
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
      anchor.paragraphs.add(index);
    }

    const fields: FieldState[] = [];
    const emit = (text: string) => {
      if (fields.some((field) => field.phase === 'instr')) return;
      paragraph.text += text;
      for (const field of fields) field.result += text;
      for (const id of open) {
        const anchor = anchors.get(id)!;
        anchor.text += text;
        anchor.paragraphs.add(index);
      }
    };
    const endField = (field: FieldState) => {
      const url = HYPERLINK_INSTR.exec(field.instr)?.[1];
      if (url !== undefined) {
        paragraph.links.push({ text: field.result.trim(), url });
      }
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
              anchors.set(id, { text: '', paragraphs: new Set([index]) });
            }
            break;
          }
          case 'w:commentRangeEnd':
            open.delete(attr(child, 'w:id') ?? '');
            break;
          case 'w:fldChar': {
            const type = attr(child, 'w:fldCharType');
            if (type === 'begin') {
              fields.push({ instr: '', result: '', phase: 'instr' });
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
            };
            fields.push(field);
            walk(child);
            fields.pop();
            const url = relationship?.target ?? (anchor ? `#${anchor}` : '');
            if (url) paragraph.links.push({ text: field.result.trim(), url });
            break;
          }
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
    paragraphs.push(paragraph);
  };

  const visitBlock = (node: Element, inTable: boolean) => {
    for (const child of children(node)) {
      if (child.nodeName === 'w:p') visitParagraph(child, inTable);
      else if (child.nodeName === 'w:tbl') visitBlock(child, true);
      else if (child.nodeName !== 'w:sectPr') visitBlock(child, inTable);
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
      comment.paragraphIndices = [...anchor.paragraphs].sort((a, b) => a - b);
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

  for (const element of commentsRoot
    ? children(commentsRoot, 'w:comment')
    : []) {
    const id = attr(element, 'w:id') ?? '';
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
      date: attr(element, 'w:date'),
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
