import {
  indexThreads,
  MAX_THREAD_DEPTH,
  PAGE_THREAD,
  visibleCounts,
} from './comment-threads';

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

  it('survives a parent loop and an endless chain', () => {
    const loop = indexThreads([
      { commentId: 'x', parentCommentId: 'y', tabId: 't' },
      { commentId: 'y', parentCommentId: 'x' },
    ]);
    expect(loop.rootOf.get('x')).toBe('y');
    expect(loop.rootOf.get('y')).toBe('x');

    const chain = Array.from({ length: MAX_THREAD_DEPTH + 5 }, (_, i) => ({
      commentId: `n${i}`,
      ...(i > 0 ? { parentCommentId: `n${i - 1}` } : {}),
    }));
    const deep = indexThreads(chain);
    expect(deep.rootOf.get(`n${MAX_THREAD_DEPTH + 4}`)).toBe('n4');
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
