import { attr, children, firstChild, parseXml, textOf } from './xml';

describe('xml helpers', () => {
  it('parses a document and reads children and attributes', () => {
    const root = parseXml('<a x="1"><b/>text<c/><b y=""/></a>', 'part.xml');

    expect(children(root).map((node) => node.nodeName)).toEqual([
      'b',
      'c',
      'b',
    ]);
    expect(children(root, 'b')).toHaveLength(2);
    expect(attr(root, 'x')).toBe('1');
    expect(attr(root, 'missing')).toBeUndefined();
    expect(attr(undefined, 'x')).toBeUndefined();
    expect(attr(children(root, 'b')[1], 'y')).toBe('');
    expect(firstChild(root, 'c')?.nodeName).toBe('c');
    expect(firstChild(undefined, 'c')).toBeUndefined();
  });

  it.each([
    ['a fatal error', '<a><b></a>', /tag mismatch/],
    ['a recoverable error', '<a>&bogus;</a>', /bogus/],
    ['an empty document', '', /missing root/],
  ])('rejects %s, naming the part', (_name, xml, reason) => {
    expect(() => parseXml(xml, 'word/x.xml')).toThrow(
      /^word\/x.xml is not valid XML/,
    );
    expect(() => parseXml(xml, 'word/x.xml')).toThrow(reason);
  });

  it('reads element text, treating a missing value as empty', () => {
    expect(textOf(parseXml('<a>hi<b>!</b></a>', 'p'))).toBe('hi!');
    expect(textOf({ textContent: null } as never)).toBe('');
  });

  it('ignores warnings', () => {
    expect(parseXml('<a x=1/>', 'p').nodeName).toBe('a');
  });
});
