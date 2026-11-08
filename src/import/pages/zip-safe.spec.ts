import { strToU8, zipSync } from 'fflate';
import { readDocx } from './docx-reader';
import { readPages } from './pages-reader';
import { MAX_ZIP_ENTRIES, MAX_ZIP_EXPANDED_BYTES, safeUnzip } from './zip-safe';

/** Rewrites the expanded size every central-directory entry declares. */
function declareSize(zip: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(zip);
  const view = new DataView(out.buffer);
  for (let at = 0; at + 46 <= out.length; at++) {
    if (view.getUint32(at, true) === 0x02014b50) {
      view.setUint32(at + 24, size, true);
    }
  }
  return out;
}

describe('safeUnzip', () => {
  it('returns the files of an ordinary package', () => {
    const files = safeUnzip(zipSync({ 'a.txt': strToU8('hello') }), '.docx');
    expect(new TextDecoder().decode(files['a.txt'])).toBe('hello');
  });

  it('accepts a package exactly at the size limit', () => {
    const zip = declareSize(
      zipSync({ 'a.bin': new Uint8Array(1) }, { level: 0 }),
      MAX_ZIP_EXPANDED_BYTES,
    );
    expect(() => safeUnzip(zip, '.docx')).not.toThrow();
  });

  it('refuses a package expanding past the limit, before inflating', () => {
    const zip = declareSize(
      zipSync({ 'a.bin': new Uint8Array(100) }, { level: 9 }),
      MAX_ZIP_EXPANDED_BYTES + 1,
    );
    expect(() => safeUnzip(zip, '.docx')).toThrow(
      `Refused: the .docx expands to more than ${MAX_ZIP_EXPANDED_BYTES} bytes.`,
    );
  });

  it('adds up sizes across entries', () => {
    const zip = declareSize(
      zipSync({ a: new Uint8Array(1), b: new Uint8Array(1) }, { level: 0 }),
      MAX_ZIP_EXPANDED_BYTES / 2 + 1,
    );
    expect(() => safeUnzip(zip, '.pages')).toThrow(/Refused: the .pages/);
  });

  it('refuses a package with too many files', () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= MAX_ZIP_ENTRIES; i++)
      files[`f${i}`] = new Uint8Array(0);
    expect(() => safeUnzip(zipSync(files), '.pages')).toThrow(
      `Refused: the .pages holds more than ${MAX_ZIP_ENTRIES} files.`,
    );
  });

  it('protects both readers', () => {
    const bomb = declareSize(
      zipSync({ 'word/document.xml': strToU8('<x/>') }, { level: 0 }),
      MAX_ZIP_EXPANDED_BYTES + 1,
    );
    expect(() => readDocx(bomb)).toThrow(/Refused: the .docx/);
    expect(() => readPages(bomb)).toThrow(/Refused: the .pages/);
  });

  it('reports anything else as not a zip', () => {
    expect(() => safeUnzip(strToU8('nope'), '.docx')).toThrow(
      /Not a .docx \(zip\) file/,
    );
  });
});
