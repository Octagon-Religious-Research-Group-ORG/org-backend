import { strToU8, zipSync } from 'fflate';
import type { DocxComment, DocxDocument } from './docx-reader';
import { crossCheck, readPages } from './pages-reader';
import { decompressIwa, MAX_SNAPPY_LENGTH, snappyDecompress } from './snappy';

/** Literal-only Snappy block (valid, if uncompressed) for test fixtures. */
function literalBlock(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let length = data.length;
  do {
    out.push((length & 0x7f) | (length > 0x7f ? 0x80 : 0));
    length >>= 7;
  } while (length > 0);
  for (let start = 0; start < data.length; start += 65536) {
    const piece = data.subarray(start, start + 65536);
    const n = piece.length - 1;
    if (n < 60) out.push(n << 2);
    else out.push(61 << 2, n & 0xff, n >> 8);
    out.push(...piece);
  }
  return new Uint8Array(out);
}

function iwa(text: string): Uint8Array {
  const block = literalBlock(strToU8(text));
  return new Uint8Array([
    0,
    block.length & 0xff,
    (block.length >> 8) & 0xff,
    block.length >> 16,
    ...block,
  ]);
}

describe('snappyDecompress', () => {
  const text = (bytes: number[]) =>
    new TextDecoder().decode(snappyDecompress(new Uint8Array(bytes)));

  it('expands literals and every kind of back-reference', () => {
    // "ab", then copy1 (len 4, off 2) -> "abab", copy2 (len 2, off 3), copy4 (len 1, off 1)
    expect(
      text([
        9,
        1 << 2,
        97,
        98,
        (0 << 2) | (0 << 5) | 1,
        2,
        ((2 - 1) << 2) | 2,
        3,
        0,
        ((1 - 1) << 2) | 3,
        1,
        0,
        0,
        0,
      ]),
    ).toBe('abababbaa');
  });

  it('reads one- and two-byte literal lengths', () => {
    const long = 'x'.repeat(70);
    expect(text([70, 60 << 2, 69, ...strToU8(long)])).toBe(long);
    expect(
      new TextDecoder().decode(snappyDecompress(literalBlock(strToU8(long)))),
    ).toBe(long);
  });

  it('reads a multi-byte length varint', () => {
    const data = new Uint8Array(200).fill(7);
    expect(snappyDecompress(literalBlock(data))).toEqual(data);
  });

  it.each([
    ['an empty input', [], /truncated/],
    [
      'an over-long varint',
      [0x80, 0x80, 0x80, 0x80, 0x80, 1],
      /varint is too long/,
    ],
    ['a literal past the end', [5, 4 << 2, 97], /literal runs past/],
    [
      'a literal longer than declared',
      [1, 1 << 2, 97, 98],
      /literal runs past/,
    ],
    ['a copy before any data', [4, 1, 1], /outside/],
    ['a copy with offset 0', [6, 1 << 2, 97, 98, 1, 0], /outside/],
    ['a copy past the declared length', [3, 1 << 2, 97, 98, 1, 2], /outside/],
    ['a short result', [3, 0, 97], /declared 3 bytes but produced 1/],
    ['a truncated copy offset', [4, 0, 97, 2], /truncated/],
  ])('rejects %s', (_name, bytes, message) => {
    expect(() => snappyDecompress(new Uint8Array(bytes))).toThrow(message);
  });
});

describe('decompressIwa', () => {
  it('joins every chunk', () => {
    const joined = new Uint8Array([...iwa('Hello '), ...iwa('world')]);
    expect(new TextDecoder().decode(decompressIwa(joined, 'X.iwa'))).toBe(
      'Hello world',
    );
  });

  it.each([
    ['a wrong header byte', [1, 0, 0, 0], /X.iwa: not an IWA chunk at byte 0/],
    ['a cut header', [0, 1], /not an IWA chunk/],
    ['a cut chunk', [0, 9, 0, 0, 1], /chunk at byte 0 is truncated/],
    [
      'a corrupt block',
      [0, 1, 0, 0, 5],
      /X.iwa: Snappy block declared 5 bytes/,
    ],
  ])('rejects %s, naming the part', (_name, bytes, message) => {
    expect(() => decompressIwa(new Uint8Array(bytes), 'X.iwa')).toThrow(
      message,
    );
  });
});

function pagesFile(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files);
}

describe('snappy limits', () => {
  /** A varint declaring `length`, with no data after it. */
  const declaring = (length: number) => {
    const out: number[] = [];
    let rest = length;
    while (rest >= 0x80) {
      out.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    out.push(rest);
    return new Uint8Array(out);
  };

  it('refuses a declared length over the limit before allocating', () => {
    expect(() => snappyDecompress(declaring(MAX_SNAPPY_LENGTH + 1))).toThrow(
      /declares too large a size/,
    );
    expect(() => snappyDecompress(declaring(2 ** 34))).toThrow(
      /declares too large a size/,
    );
  });

  it('refuses an .iwa whose chunks together exceed the limit', () => {
    // A block that repeats one byte by copying, at the limit, twice over.
    const one = (() => {
      const header = [...declaring(MAX_SNAPPY_LENGTH), 0, 7];
      const copies = Math.ceil((MAX_SNAPPY_LENGTH - 1) / 64);
      const tail = (MAX_SNAPPY_LENGTH - 1) % 64 || 64;
      const out = new Uint8Array(header.length + copies * 3);
      out.set(header);
      for (let i = 0; i < copies; i++) {
        const length = i === copies - 1 ? tail : 64;
        out.set([((length - 1) << 2) | 2, 1, 0], header.length + i * 3);
      }
      return out;
    })();
    const chunk = new Uint8Array(4 + one.length);
    chunk.set([
      0,
      one.length & 0xff,
      (one.length >> 8) & 0xff,
      (one.length >> 16) & 0xff,
    ]);
    chunk.set(one, 4);
    const twice = new Uint8Array(chunk.length * 2);
    twice.set(chunk);
    twice.set(chunk, chunk.length);
    expect(() => decompressIwa(twice, 'Index/X.iwa')).toThrow(
      /Index\/X.iwa: expands to more than/,
    );
  });
});

describe('readPages', () => {
  it('reads the document, the author table and every embedded file', () => {
    const big = new Uint8Array(30).fill(1);
    const pages = readPages(
      pagesFile({
        'Index/Document.iwa': iwa('I agree with this'),
        'Index/AnnotationAuthorStorage-1732610.iwa': iwa('Bram ORG'),
        'Data/IMG_0001-55.jpeg': big,
        'Data/pasted-movie-small-35.png': new Uint8Array(5),
        'Data/b.png': new Uint8Array(5),
        'Data/notes.plist': new Uint8Array(10),
        'Data/empty.png': new Uint8Array(0),
      }),
    );

    expect(pages.documentText).toBe('I agree with this');
    expect(pages.authorText).toBe('Bram ORG');
    expect(
      pages.dataFiles.map((f) => [f.path, f.bytes, f.image, f.thumbnail]),
    ).toEqual([
      ['Data/IMG_0001-55.jpeg', 30, true, false],
      ['Data/notes.plist', 10, false, false],
      ['Data/b.png', 5, true, false],
      ['Data/pasted-movie-small-35.png', 5, true, true],
    ]);
    expect(pages.dataFiles[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pages.dataFiles[0].data).toEqual(big);
  });

  it('accepts a package without an author table', () => {
    expect(
      readPages(pagesFile({ 'Index/Document.iwa': iwa('x') })).authorText,
    ).toBeUndefined();
  });

  it('rejects a file that is not a zip', () => {
    expect(() => readPages(strToU8('nope'))).toThrow(/Not a .pages/);
  });

  it('rejects a zip without Index/Document.iwa', () => {
    expect(() => readPages(pagesFile({ 'a.txt': strToU8('x') }))).toThrow(
      /no Index\/Document.iwa/,
    );
  });
});

describe('crossCheck', () => {
  const comment = (id: string, author: string, text: string): DocxComment => ({
    id,
    author,
    text,
    anchorText: '',
    paragraphIndices: [],
    anchored: false,
  });
  const docx = (comments: DocxComment[]): DocxDocument => ({
    paragraphs: [],
    comments,
    media: new Map(),
    warnings: [],
  });
  const pages = (documentText: string, authorText?: string) => ({
    dataFiles: [],
    documentText,
    authorText,
  });

  it('passes when every comment and author is present, ignoring layout', () => {
    const result = crossCheck(
      docx([
        comment('1', 'Bram ORG', 'Double letter'),
        comment('2', 'Wren', 'First line\n\nsecond   line'),
      ]),
      pages(
        'xx Double letter yy First line zz second line',
        // As in the real table: names held apart by non-text protobuf bytes.
        '\u0000\n\u0005Wren\u0012\u0002\n\tBram   ORG\u0012',
      ),
    );

    expect(result).toEqual({
      comments: { total: 2, found: 2, missing: [] },
      authors: {
        status: 'ok',
        total: 2,
        found: 2,
        missing: [],
        pagesOnly: [],
      },
      commentsLost: false,
      status: 'ok',
    });
  });

  it('matches an author as a whole name, not a part of one', () => {
    const result = crossCheck(
      docx([comment('1', 'Bram', 'x')]),
      pages('x', 'Bram ORG'),
    );
    expect(result.authors.missing).toEqual(['Bram']);
    expect(result.status).toBe('mismatch');
  });

  it('counts a blank author as missing instead of skipping it', () => {
    const result = crossCheck(
      docx([comment('1', '  ', 'x')]),
      pages('x', 'Someone'),
    );
    expect(result.authors).toEqual({
      status: 'mismatch',
      total: 1,
      found: 0,
      missing: ['(no author)'],
      pagesOnly: ['Someone'],
    });
  });

  it('calls no comments against a named author table a mismatch', () => {
    const result = crossCheck(docx([]), pages('x', 'Someone'));
    expect(result.commentsLost).toBe(true);
    expect(result.status).toBe('mismatch');
  });

  it('accepts no comments against an empty author table', () => {
    const result = crossCheck(docx([]), pages('x', '\u0000\u0012'));
    expect(result.commentsLost).toBe(false);
    expect(result.status).toBe('ok');
  });

  it('lists a .pages author with no comment, and ignores table noise', () => {
    const result = crossCheck(
      docx([comment('1', 'Kept', 'x')]),
      pages('x', 'Kept\u0000Gone Person\u0000x7\u000012\u0000'),
    );
    expect(result.authors.pagesOnly).toEqual(['Gone Person']);
    expect(result.status).toBe('ok');
  });

  it('reports the comments and authors it cannot find', () => {
    const result = crossCheck(
      docx([comment('1', 'A', 'present'), comment('2', 'B', 'absent')]),
      pages('present', 'A'),
    );

    expect(result.comments).toEqual({ total: 2, found: 1, missing: ['2'] });
    expect(result.authors).toEqual({
      status: 'mismatch',
      total: 2,
      found: 1,
      missing: ['B'],
      pagesOnly: [],
    });
    expect(result.status).toBe('mismatch');
  });

  it('says it cannot check authors when there is no author table', () => {
    const result = crossCheck(docx([comment('1', 'A', 'x')]), pages('x'));

    expect(result.authors).toEqual({
      status: 'cannot-measure',
      total: 1,
      found: 0,
      missing: [],
      pagesOnly: [],
    });
    expect(result.status).toBe('cannot-measure');
  });

  it('a missing comment outranks an unmeasurable author table', () => {
    expect(crossCheck(docx([comment('1', 'A', 'x')]), pages('y')).status).toBe(
      'mismatch',
    );
  });
});
