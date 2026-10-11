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
