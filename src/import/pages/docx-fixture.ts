import { strToU8, zipSync } from 'fflate';

/**
 * Builds a small synthetic .docx in memory for tests. Never use real member
 * documents as fixtures: this repository is public.
 */
export interface DocxParts {
  /** Inner XML of `<w:body>`. */
  body: string;
  numbering?: string;
  styles?: string;
  comments?: string;
  commentsExtended?: string;
  /** Inner XML of `<Relationships>`. */
  rels?: string;
  media?: Record<string, Uint8Array>;
  /** Replace document.xml entirely (for malformed-XML tests). */
  rawDocument?: string;
}

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ' +
  'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';

export function buildDocx(parts: DocxParts): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'word/document.xml': strToU8(
      parts.rawDocument ??
        `<?xml version="1.0"?><w:document ${W}><w:body>${parts.body}</w:body></w:document>`,
    ),
  };
  const add = (path: string, xml: string | undefined, root: string) => {
    if (xml !== undefined) {
      files[path] = strToU8(
        `<?xml version="1.0"?><${root} ${W}>${xml}</${root.split(' ')[0]}>`,
      );
    }
  };
  add('word/numbering.xml', parts.numbering, 'w:numbering');
  add('word/styles.xml', parts.styles, 'w:styles');
  add('word/comments.xml', parts.comments, 'w:comments');
  add('word/commentsExtended.xml', parts.commentsExtended, 'w15:commentsEx');
  if (parts.rels !== undefined) {
    files['word/_rels/document.xml.rels'] = strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts.rels}</Relationships>`,
    );
  }
  for (const [path, data] of Object.entries(parts.media ?? {})) {
    files[path] = data;
  }
  return zipSync(files);
}

/** One literal-only Snappy block holding all of `text`, as an .iwa file. */
function iwaOf(text: string): Uint8Array {
  const data = strToU8(text);
  const block: number[] = [];
  let length = data.length;
  do {
    block.push((length & 0x7f) | (length > 0x7f ? 0x80 : 0));
    length >>= 7;
  } while (length > 0);
  if (data.length > 0) {
    block.push(61 << 2, (data.length - 1) & 0xff, (data.length - 1) >> 8);
    block.push(...data);
  }
  return new Uint8Array([
    0,
    block.length & 0xff,
    (block.length >> 8) & 0xff,
    block.length >> 16,
    ...block,
  ]);
}

/** Builds a small synthetic .pages package in memory for tests. */
export function buildPages(
  document: string,
  authors?: string,
  data: Record<string, Uint8Array> = {},
): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'Index/Document.iwa': iwaOf(document),
    ...data,
  };
  if (authors !== undefined) {
    files['Index/AnnotationAuthorStorage-1.iwa'] = iwaOf(authors);
  }
  return zipSync(files);
}

/** A paragraph with optional style and plain runs. */
export function p(text: string, props = ''): string {
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

export function numbered(text: string, numId: string, level: number): string {
  return p(
    text,
    `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`,
  );
}
