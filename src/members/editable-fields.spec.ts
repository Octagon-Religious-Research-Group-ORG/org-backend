import { IMPORT_AUTHOR } from '../import/pages/import-plan';
import {
  editorText,
  firstTextBlockId,
  IMPORTED_AUTHOR,
  normaliseFieldText,
  normaliseTitle,
  TITLE_RECORD_AUTHOR,
  titleBlockId,
  versionSource,
  visibleFieldBlocks,
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

  describe('what a reader sees of a text field', () => {
    const blocks = [
      { blockId: 'a', kind: 'outline-item', label: 'I.', currentVersionSeq: 1 },
      { blockId: 'b', kind: 'paragraph', label: '', currentVersionSeq: 1 },
    ];

    it('every paragraph, as stored, until the field is edited', () => {
      expect(visibleFieldBlocks(blocks)).toEqual(blocks);
      expect(visibleFieldBlocks([])).toEqual([]);
      expect(visibleFieldBlocks([{ kind: 'paragraph' }])).toEqual([
        { kind: 'paragraph' },
      ]);
    });

    it('only the first block, as a plain paragraph, once it shows an edit', () => {
      const edited = [{ ...blocks[0], currentVersionSeq: 2 }, blocks[1]];
      expect(visibleFieldBlocks(edited)).toEqual([
        { blockId: 'a', kind: 'paragraph', label: '', currentVersionSeq: 2 },
      ]);
    });
  });
});
