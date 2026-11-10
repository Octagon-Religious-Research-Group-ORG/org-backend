import { IMPORT_AUTHOR } from '../import/pages/import-plan';
import {
  editorText,
  firstTextBlockId,
  holdsWholeText,
  IMPORTED_AUTHOR,
  normaliseFieldText,
  normaliseTitle,
  TITLE_RECORD_AUTHOR,
  titleBlockId,
  versionSource,
} from './editable-fields';

describe('editable fields', () => {
  it('names the importer exactly as the importer does', () => {
    expect(IMPORTED_AUTHOR).toBe(IMPORT_AUTHOR);
  });

  it('gives fixed ids to the blocks a field gets on its first save', () => {
    expect(titleBlockId('tab_1')).toBe('ttl_tab_1');
    expect(firstTextBlockId('bio', 'p1')).toBe('bio_p1');
    expect(firstTextBlockId('tab', 'tab_1')).toBe('txt_tab_1');
  });

  it('starts an editor from each block, label in front', () => {
    expect(
      editorText([
        { label: 'II.', text: 'Sky.' },
        { text: 'Sea.' },
        { label: '', text: 'Land.' },
      ]),
    ).toBe('II. Sky.\n\nSea.\n\nLand.');
  });

  it('normalises text so the same reading compares equal', () => {
    expect(normaliseFieldText('  a\r\n\n\n\n b \u202e\n')).toBe('a\n\nb');
    expect(normaliseFieldText('\u200b\n\n ')).toBe('');
    expect(normaliseTitle(' A\ttitle\n')).toBe('A title');
  });

  it('labels where a version came from without naming its author', () => {
    expect(versionSource(IMPORT_AUTHOR)).toBe('imported');
    expect(versionSource(TITLE_RECORD_AUTHOR)).toBe('title-before-history');
    expect(versionSource('user_abc')).toBe('member');
  });

  describe('whole text or one paragraph of it', () => {
    it('a field that only ever had one block: every version is whole', () => {
      expect(holdsWholeText({ blockId: 'a', seq: 1 }, ['a'])).toBe(true);
    });

    it('a field of several blocks: only edits of its first block are whole', () => {
      const ids = ['a', 'b'];
      expect(holdsWholeText({ blockId: 'a', seq: 1 }, ids)).toBe(false);
      expect(holdsWholeText({ blockId: 'a', seq: 2 }, ids)).toBe(true);
      expect(holdsWholeText({ blockId: 'b', seq: 1 }, ids)).toBe(false);
    });
  });
});
