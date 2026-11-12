import { indexThreads, PAGE_THREAD, visibleCounts } from './comment-threads';

describe('comment threads', () => {
  it('puts a reply in its root thread, whatever its own tab says', () => {
    const index = indexThreads([
      { commentId: 'a', tabId: 't1' },
      { commentId: 'b', tabId: 't2', parentCommentId: 'a' },
      { commentId: 'c', parentCommentId: 'b' },
      { commentId: 'd' },
      { commentId: 'e', tabId: 't1', parentCommentId: 'missing' },
    ]);
    expect(index.rootOf.get('c')).toBe('a');
    expect(index.threadOf.get('c')).toBe('t1');
    expect(index.rootsByThread.get('t1')).toEqual(['a', 'e']);
    expect(index.rootsByThread.get(PAGE_THREAD)).toEqual(['d']);
    expect(index.repliesOf.get('a')).toEqual(['b', 'c']);
  });

  it('cuts a parent loop at its smallest id, whichever comment the walk starts from', () => {
    const loop = indexThreads([
      { commentId: 'y', parentCommentId: 'x', tabId: 't' },
      { commentId: 'x', parentCommentId: 'z', tabId: 't' },
      { commentId: 'z', parentCommentId: 'y', tabId: 't' },
      { commentId: 'w', parentCommentId: 'z', tabId: 't' },
    ]);
    for (const id of ['x', 'y', 'z', 'w']) {
      expect(loop.rootOf.get(id)).toBe('x');
    }
    expect(loop.rootsByThread.get('t')).toEqual(['x']);
    expect(loop.repliesOf.get('x')).toEqual(['y', 'z', 'w']);
    // Every row is in exactly one place: listed and counted alike.
    expect(
      visibleCounts(
        [...loop.rootOf.keys()].map((commentId) => ({ commentId, tabId: 't' })),
      ),
    ).toEqual(new Map([['t', 4]]));
  });

  it('follows a long chain to its top', () => {
    const chain = Array.from({ length: 100 }, (_, i) => ({
      commentId: `n${String(i).padStart(3, '0')}`,
      ...(i > 0
        ? { parentCommentId: `n${String(i - 1).padStart(3, '0')}` }
        : {}),
    }));
    expect(indexThreads(chain).rootOf.get('n099')).toBe('n000');
  });

  it('counts what a reader sees, removed ones left out', () => {
    expect(
      visibleCounts([
        { commentId: 'a', tabId: 't' },
        { commentId: 'b', parentCommentId: 'a', removedAt: new Date() },
        { commentId: 'c', parentCommentId: 'a' },
        { commentId: 'd', removedAt: null },
      ]),
    ).toEqual(
      new Map([
        ['t', 2],
        [PAGE_THREAD, 1],
      ]),
    );
  });
});
