import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import type { DocxDocument } from './docx-reader';
import { decompressIwa } from './snappy';

export interface PagesDataFile {
  /** Path inside the package, e.g. "Data/IMG_4970-55.jpeg". */
  path: string;
  bytes: number;
  sha256: string;
  image: boolean;
  /** Pages keeps small preview copies ("-small-") next to the originals. */
  thumbnail: boolean;
  data: Uint8Array;
}

export interface PagesPackage {
  /** Embedded files, largest first: photos at full size, as the member added them. */
  dataFiles: PagesDataFile[];
  /** Decoded text of Index/Document.iwa, for the cross-check only. */
  documentText: string;
  /**
   * Decoded text of the comment-author table, for the cross-check only;
   * undefined when the package has none (then authors cannot be checked).
   */
  authorText?: string;
}

const IMAGE_EXTENSIONS = /\.(jpe?g|png|tiff?|heic|gif|webp)$/i;

/**
 * Reads the parts of an Apple Pages `.pages` package the import needs:
 * the full-size photos in `Data/` (Word drops gallery photos, plan §7) and
 * the decompressed document and comment-author tables used to cross-check
 * the .docx.
 *
 * The .iwa tables are protobuf. They are NOT parsed here: the cross-check
 * only asks whether each comment and author the .docx reports is present,
 * which needs the decompressed bytes and nothing else.
 *
 * @throws Error when the file is not a .pages package
 */
export function readPages(bytes: Uint8Array): PagesPackage {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    throw new Error(`Not a .pages (zip) file: ${(error as Error).message}`);
  }
  const document = files['Index/Document.iwa'];
  if (!document) throw new Error('The .pages file has no Index/Document.iwa.');

  const decode = (data: Uint8Array) => new TextDecoder('utf-8').decode(data);
  // Named with an id suffix, e.g. "AnnotationAuthorStorage-1732610.iwa".
  const authorPart = Object.keys(files).find((path) =>
    /^Index\/AnnotationAuthorStorage(-\d+)?\.iwa$/.test(path),
  );

  const dataFiles = Object.entries(files)
    .filter(([path, data]) => path.startsWith('Data/') && data.length > 0)
    .map(([path, data]) => ({
      path,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      image: IMAGE_EXTENSIONS.test(path),
      thumbnail: /-small-/i.test(path),
      data,
    }))
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));

  return {
    dataFiles,
    documentText: decode(decompressIwa(document, 'Index/Document.iwa')),
    authorText: authorPart
      ? decode(decompressIwa(files[authorPart], authorPart))
      : undefined,
  };
}

export type CheckStatus = 'ok' | 'mismatch' | 'cannot-measure';

export interface CrossCheck {
  comments: { total: number; found: number; missing: string[] };
  /** `cannot-measure` when the .pages has no author table. */
  authors: {
    status: CheckStatus;
    total: number;
    found: number;
    missing: string[];
  };
  /** `ok` only when every comment text AND every author was found. */
  status: CheckStatus;
}

/** Collapses whitespace and normalises Unicode so formatting cannot hide a match. */
function normalise(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/**
 * Checks the .docx against the .pages: every comment's text must appear in
 * the Pages document, and every comment author in its author table. A comment
 * is looked for line by line, because the .iwa stores the text of a
 * multi-paragraph comment in pieces.
 */
export function crossCheck(
  docx: DocxDocument,
  pages: PagesPackage,
): CrossCheck {
  const documentText = normalise(pages.documentText);

  const missingComments = docx.comments
    .filter((comment) =>
      comment.text
        .split('\n')
        .map(normalise)
        .filter(Boolean)
        .some((line) => !documentText.includes(line)),
    )
    .map((comment) => comment.id);

  const authors = [...new Set(docx.comments.map((comment) => comment.author))]
    .filter(Boolean)
    .sort();
  const authorText =
    pages.authorText === undefined ? undefined : normalise(pages.authorText);
  const missingAuthors =
    authorText === undefined
      ? []
      : authors.filter((author) => !authorText.includes(normalise(author)));
  const authorStatus: CheckStatus =
    authorText === undefined
      ? 'cannot-measure'
      : missingAuthors.length > 0
        ? 'mismatch'
        : 'ok';

  return {
    comments: {
      total: docx.comments.length,
      found: docx.comments.length - missingComments.length,
      missing: missingComments,
    },
    authors: {
      status: authorStatus,
      total: authors.length,
      found:
        authorText === undefined ? 0 : authors.length - missingAuthors.length,
      missing: missingAuthors,
    },
    status: missingComments.length > 0 ? 'mismatch' : authorStatus,
  };
}
