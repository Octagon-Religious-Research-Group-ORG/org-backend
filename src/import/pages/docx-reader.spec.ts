import { strToU8, zipSync } from 'fflate';
import { buildDocx, numbered, p } from './docx-fixture';
import { formatNumber } from './docx-numbering';
import { readDocx } from './docx-reader';

const STYLES =
  '<w:style w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>' +
  '<w:style w:styleId="Title"><w:name w:val="Title"/></w:style>' +
  '<w:style w:styleId="Body"><w:name w:val="Body"/></w:style>' +
  '<w:style w:styleId="NoName"/>';

const lvl = (ilvl: number, format: string, text: string, start = 1) =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="${start}"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/></w:lvl>`;

describe('readDocx', () => {
  describe('paragraphs', () => {
    it('reads text, tabs, breaks, style names and heading levels', () => {
      const doc = readDocx(
        buildDocx({
          styles: STYLES,
          body:
            p('Profile', '<w:pStyle w:val="Title"/>') +
            p('Bio', '<w:pStyle w:val="Heading2"/>') +
            '<w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t><w:cr/><w:noBreakHyphen/></w:r></w:p>' +
            p('unknown style', '<w:pStyle w:val="Custom"/>') +
            p('nameless', '<w:pStyle w:val="NoName"/>') +
            '<w:tbl><w:tr><w:tc>' +
            p('in a table') +
            '</w:tc></w:tr></w:tbl>' +
            '<w:sectPr/>',
        }),
      );

      expect(
        doc.paragraphs.map((x) => [x.style, x.headingLevel, x.text, x.inTable]),
      ).toEqual([
        ['Title', 0, 'Profile', false],
        ['heading 2', 2, 'Bio', false],
        ['Body', undefined, 'a\tb\nc\n-', false],
        ['Custom', undefined, 'unknown style', false],
        ['NoName', undefined, 'nameless', false],
        ['', undefined, 'in a table', true],
      ]);
      expect(doc.warnings).toEqual([]);
    });

    it('keeps tracked insertions and drops tracked deletions', () => {
      const doc = readDocx(
        buildDocx({
          body:
            '<w:p><w:r><w:t>keep </w:t></w:r><w:ins><w:r><w:t>new </w:t></w:r></w:ins>' +
            '<w:del><w:r><w:delText>old </w:delText></w:r></w:del>' +
            '<w:moveFrom><w:r><w:t>moved </w:t></w:r></w:moveFrom>' +
            '<w:r><w:rPr><w:b/></w:rPr><w:t>end</w:t></w:r></w:p>',
        }),
      );
      expect(doc.paragraphs[0].text).toBe('keep new end');
    });
  });

  describe('links', () => {
    it('reads HYPERLINK fields for their URL without leaking the code', () => {
      const doc = readDocx(
        buildDocx({
          body:
            '<w:p><w:r><w:t xml:space="preserve">See </w:t></w:r>' +
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
            '<w:r><w:instrText xml:space="preserve"> HYPERLINK "https://example.test/a#X"</w:instrText></w:r>' +
            '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
            '<w:r><w:t>the page</w:t></w:r>' +
            '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r>' +
            '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>4</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>' +
            '<w:fldSimple w:instr=" HYPERLINK \\l &quot;top&quot; "><w:r><w:t> up </w:t></w:r></w:fldSimple>' +
            '<w:fldSimple w:instr=" DATE "><w:r><w:t>today</w:t></w:r></w:fldSimple>' +
            '<w:fldSimple><w:r><w:t>!</w:t></w:r></w:fldSimple>' +
            '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:instrText>stray</w:instrText></w:r>' +
            '</w:p>',
        }),
      );

      expect(doc.paragraphs[0].text).toBe('See the page4 up today!');
      expect(doc.paragraphs[0].links).toEqual([
        { text: 'the page', url: 'https://example.test/a#X' },
        { text: 'up', url: 'top' },
      ]);
    });

    it('reads w:hyperlink elements by relationship or bookmark', () => {
      const doc = readDocx(
        buildDocx({
          rels:
            '<Relationship Id="rLink" Target="https://example.test/b" TargetMode="External"/>' +
            '<Relationship Id="rNoTarget"/>',
          body:
            '<w:p><w:hyperlink r:id="rLink"><w:r><w:t>web</w:t></w:r></w:hyperlink>' +
            '<w:hyperlink w:anchor="mark"><w:r><w:t>local</w:t></w:r></w:hyperlink>' +
            '<w:hyperlink r:id="missing"><w:r><w:t>dead</w:t></w:r></w:hyperlink></w:p>',
        }),
      );
      expect(doc.paragraphs[0].links).toEqual([
        { text: 'web', url: 'https://example.test/b' },
        { text: 'local', url: '#mark' },
      ]);
      expect(doc.paragraphs[0].text).toBe('weblocaldead');
    });
  });

  describe('numbering', () => {
    const numbering =
      '<w:abstractNum w:abstractNumId="0">' +
      lvl(0, 'upperRoman', '%1.') +
      lvl(1, 'upperLetter', '%2.') +
      lvl(2, 'decimal', '%1.%2.%3') +
      '<w:lvl w:ilvl="3"><w:lvlText w:val="(%4)"/></w:lvl>' +
      lvl(4, 'bullet', '•') +
      lvl(5, 'decimal', '%6/%8') +
      '</w:abstractNum>' +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
      '<w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num>' +
      '<w:num w:numId="9"/>';

    it('computes labels the way Word displays them', () => {
      const doc = readDocx(
        buildDocx({
          numbering,
          body:
            numbered('God', '1', 0) +
            numbered('one', '1', 1) +
            numbered('two', '1', 1) +
            numbered('deep', '1', 2) +
            numbered('plain', '1', 3) +
            numbered('dot', '1', 4) +
            numbered('gap', '1', 5) +
            numbered('Soul', '2', 0) +
            numbered('restart', '1', 1) +
            numbered('none', '0', 0),
        }),
      );

      expect(
        doc.paragraphs.map((x) => x.numbering && x.numbering.label),
      ).toEqual([
        'I.',
        'A.',
        'B.',
        'I.B.1',
        '(1)',
        '',
        '1/1',
        'II.',
        'A.',
        undefined,
      ]);
    });

    it('follows a list that points at a list style (as Pages exports)', () => {
      const doc = readDocx(
        buildDocx({
          numbering:
            '<w:abstractNum w:abstractNumId="0"><w:numStyleLink w:val="Outline"/></w:abstractNum>' +
            '<w:abstractNum w:abstractNumId="1"><w:styleLink w:val="Outline"/>' +
            lvl(0, 'lowerRoman', '%1)', 3) +
            '</w:abstractNum>' +
            '<w:abstractNum w:abstractNumId="2"><w:numStyleLink w:val="Nowhere"/></w:abstractNum>' +
            '<w:abstractNum><w:styleLink w:val="NoId"/></w:abstractNum>' +
            '<w:abstractNum><w:numStyleLink w:val="NoIdEither"/></w:abstractNum>' +
            '<w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num>' +
            '<w:num w:numId="6"><w:abstractNumId w:val="2"/></w:num>' +
            '<w:abstractNum w:abstractNumId="3"><w:lvl/></w:abstractNum>' +
            '<w:num w:numId="7"><w:abstractNumId w:val="3"/></w:num>',
          body:
            numbered('x', '5', 0) +
            numbered('y', '5', 0) +
            numbered('z', '6', 0) +
            numbered('bare', '7', 0),
        }),
      );

      expect(doc.paragraphs.map((x) => x.numbering?.label)).toEqual([
        'iii)',
        'iv)',
        undefined,
        '',
      ]);
      expect(doc.warnings).toEqual([
        'Paragraph 2: list 6 level 0 is not defined in numbering.xml.',
      ]);
    });

    it('warns instead of guessing when a list is undefined', () => {
      const doc = readDocx(
        buildDocx({ body: numbered('x', '7', 0) + p('y', '<w:numPr/>') }),
      );
      expect(doc.paragraphs[0].numbering).toBeUndefined();
      expect(doc.warnings).toEqual([
        'Paragraph 0: list 7 level 0 is not defined in numbering.xml.',
      ]);
    });

    it.each([
      [4, 'lowerRoman', 'iv'],
      [1994, 'upperRoman', 'MCMXCIV'],
      [2, 'lowerLetter', 'b'],
      [27, 'upperLetter', 'AA'],
      [12, 'decimal', '12'],
      [5, 'ordinal', '5'],
    ])('formats %p as %s → %s', (value, format, expected) => {
      expect(formatNumber(value, format)).toBe(expected);
    });
  });

  describe('comments', () => {
    const comment = (
      id: string,
      author: string,
      text: string,
      paraId: string,
    ) =>
      `<w:comment w:id="${id}" w:author="${author}" w:date="2026-07-26T13:19:54Z">` +
      `<w:p w14:paraId="${paraId}"><w:r><w:annotationRef/></w:r><w:r><w:t>${text}</w:t><w:tab/><w:t>!</w:t></w:r></w:p></w:comment>`;

    it('keeps author, date, reply parent and the exact highlighted text', () => {
      const doc = readDocx(
        buildDocx({
          comments:
            comment('1', 'Tripp ORG', 'Double letter', 'AAA') +
            comment('2', 'Emily', 'I agree', 'BBB') +
            '<w:comment w:id="3"><w:p><w:r><w:t>first</w:t></w:r><w:r><w:br/><w:delText>x</w:delText><w:instrText>y</w:instrText></w:r></w:p>' +
            '<w:p w14:paraId="CCC"><w:r><w:t>second</w:t></w:r></w:p></w:comment>' +
            comment('4', 'Leo', 'never placed', 'DDD'),
          commentsExtended:
            '<w15:commentEx w15:paraId="BBB" w15:paraIdParent="AAA"/>' +
            '<w15:commentEx w15:paraId="AAA"/>' +
            '<w15:commentEx w15:paraId="CCC" w15:paraIdParent="AAA"/>',
          body:
            '<w:p><w:r><w:t xml:space="preserve">I. </w:t></w:r><w:commentRangeStart w:id="1"/><w:commentRangeStart w:id="2"/><w:r><w:t>God is</w:t></w:r></w:p>' +
            '<w:p><w:r><w:t>one</w:t></w:r><w:commentRangeEnd w:id="1"/><w:commentRangeEnd w:id="2"/></w:p>' +
            '<w:p><w:commentRangeStart w:id="3"/><w:commentRangeEnd w:id="3"/></w:p>',
        }),
      );

      expect(doc.comments).toEqual([
        {
          id: '1',
          author: 'Tripp ORG',
          date: '2026-07-26T13:19:54Z',
          text: 'Double letter\t!',
          anchorText: 'God is\none',
          paragraphIndices: [0, 1],
          anchored: true,
        },
        expect.objectContaining({
          id: '2',
          parentId: '1',
          anchorText: 'God is\none',
        }),
        expect.objectContaining({
          id: '3',
          author: '',
          date: undefined,
          text: 'first\n\nsecond',
          parentId: '1',
          anchorText: '',
          paragraphIndices: [2],
          anchored: true,
        }),
        expect.objectContaining({
          id: '4',
          anchored: false,
          anchorText: '',
          paragraphIndices: [],
        }),
      ]);
      expect(doc.warnings).toEqual([]);
    });

    it('warns about broken highlights and replies', () => {
      const doc = readDocx(
        buildDocx({
          comments:
            comment('1', 'A', 'x', 'AAA') +
            '<w:comment w:id="2"><w:p w14:paraId="P1"/><w:p w14:paraId="P2"/></w:comment>' +
            '<w:comment><w:p/></w:comment>',
          commentsExtended:
            '<w15:commentEx w15:paraId="AAA" w15:paraIdParent="GONE"/>' +
            '<w15:commentEx w15:paraId="P1" w15:paraIdParent="AAA"/>' +
            '<w15:commentEx w15:paraId="NOPE" w15:paraIdParent="AAA"/>',
          body:
            '<w:p><w:commentRangeStart w:id="9"/><w:r><w:t>orphan</w:t></w:r><w:commentRangeEnd w:id="9"/>' +
            '<w:commentRangeStart w:id="1"/><w:r><w:t>open</w:t></w:r></w:p>' +
            '<w:p><w:commentRangeStart/><w:commentRangeEnd/></w:p>',
        }),
      );

      expect(doc.comments.find((c) => c.id === '2')?.parentId).toBeUndefined();
      expect(doc.warnings).toEqual([
        'A reply in commentsExtended.xml points at a comment that does not exist (GONE).',
        'A reply in commentsExtended.xml points at a comment that does not exist (AAA).',
        'Comment 1: highlight starts but never ends.',
        'Highlight 9 has no matching comment in comments.xml.',
      ]);
    });
  });

  describe('edge cases seen in exports', () => {
    it('handles level-less lists, late highlights, text inside field codes and repeated starts', () => {
      const doc = readDocx(
        buildDocx({
          numbering:
            '<w:abstractNum w:abstractNumId="0">' +
            lvl(0, 'decimal', '%1.') +
            '</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
          comments:
            '<w:comment w:id="1" w:author="A"><w:p w14:paraId="X1"><w:r><w:t>c</w:t></w:r></w:p></w:comment>',
          commentsExtended: '<w15:commentEx w15:paraIdParent="X1"/>',
          body:
            '<w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>first</w:t></w:r>' +
            '<w:commentRangeStart w:id="1"/></w:p>' +
            '<w:p><w:commentRangeStart w:id="1"/>' +
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:t>hidden</w:t></w:r>' +
            '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>shown</w:t></w:r>' +
            '<w:r><w:fldChar w:fldCharType="end"/></w:r><w:commentRangeEnd w:id="1"/></w:p>',
        }),
      );

      expect(doc.paragraphs[0].numbering).toEqual({
        numId: '1',
        level: 0,
        label: '1.',
      });
      expect(doc.paragraphs[1].text).toBe('shown');
      expect(doc.comments[0]).toEqual(
        expect.objectContaining({
          anchorText: 'shown',
          paragraphIndices: [0, 1],
        }),
      );
      expect(doc.comments[0].parentId).toBeUndefined();
      // A reply entry with no id of its own cannot be placed: reported, not guessed.
      expect(doc.warnings).toEqual([
        'A reply in commentsExtended.xml points at a comment that does not exist (X1).',
      ]);
    });
  });

  describe('images', () => {
    it('lists embedded images once and keeps every media file', () => {
      const png = new Uint8Array([1, 2, 3]);
      const doc = readDocx(
        buildDocx({
          rels:
            '<Relationship Id="rImg" Target="media/image1.png"/>' +
            '<Relationship Id="rAbs" Target="/word/media/image2.png"/>' +
            '<Relationship Id="rWeb" Target="https://example.test/x.png" TargetMode="External"/>',
          media: { 'word/media/image1.png': png, 'word/media/image2.png': png },
          body:
            '<w:p><w:r><w:drawing><a:blip r:embed="rImg"/></w:drawing></w:r>' +
            '<mc:AlternateContent><mc:Choice><w:drawing><a:blip r:embed="rAbs"/></w:drawing></mc:Choice>' +
            '<mc:Fallback><w:pict><v:imagedata r:id="rAbs"/></w:pict></mc:Fallback></mc:AlternateContent>' +
            '<mc:AlternateContent><mc:Fallback/></mc:AlternateContent>' +
            '<w:pict><v:imagedata r:id="rImg"/></w:pict>' +
            '<a:blip r:embed="rWeb"/><a:blip/>' +
            '<w:del><w:r><w:drawing><a:blip r:embed="rImg"/></w:drawing></w:r></w:del></w:p>',
        }),
      );

      expect(doc.paragraphs[0].images).toEqual([
        'word/media/image1.png',
        'word/media/image2.png',
        'word/media/image1.png',
      ]);
      expect([...doc.media.keys()]).toEqual([
        'word/media/image1.png',
        'word/media/image2.png',
      ]);
      expect(doc.warnings).toEqual([
        'Paragraph 0: image rWeb has no embedded file.',
        'Paragraph 0: image (no id) has no embedded file.',
      ]);
    });
  });

  describe('bad input', () => {
    it('rejects a file that is not a zip', () => {
      expect(() => readDocx(strToU8('not a zip'))).toThrow(/Not a .docx/);
    });

    it('rejects a zip without a document body', () => {
      expect(() => readDocx(zipSync({ 'a.txt': strToU8('x') }))).toThrow(
        /no word\/document.xml body/,
      );
    });

    it('names the part that is not valid XML', () => {
      expect(() =>
        readDocx(buildDocx({ body: '', rawDocument: '<w:document><w:body>' })),
      ).toThrow(/word\/document.xml is not valid XML/);
    });
  });
});
