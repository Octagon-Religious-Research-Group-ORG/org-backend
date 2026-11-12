import { Types } from 'mongoose';
import { fakeModel } from '../../test-support/fake-model.mocks-spec';
import { endTextTurn } from '../tab-text-turns';
import { commentCounts, CommentStore } from './comment-store';

const page = new Types.ObjectId();
const other = new Types.ObjectId();
const at = new Date('2026-11-01T00:00:00.000Z');
const row = (commentId: string, extra: Record<string, unknown> = {}) => ({
  commentId,
  profileId: page,
  body: commentId,
  bodySeq: 1,
  source: 'native',
  kind: 'comment',
  createdAt: at,
  ...extra,
});

function store(rows: Record<string, unknown>[]) {
  const model = fakeModel(rows);
  return { model, store: new CommentStore(model as never) };
}

describe('CommentStore', () => {
  const imported = (commentId: string, extra: Record<string, unknown> = {}) =>
    row(commentId, { source: 'migrated', bodySeq: undefined, ...extra });

  it('places an imported comment by its chain: a missing parent or a loop ends it the same way every time', async () => {
    const { store: s } = store([
      imported('a'),
      imported('b', { parentCommentId: 'a' }),
      imported('c', { parentCommentId: 'b' }),
      imported('orphan', { parentCommentId: 'gone' }),
      imported('x', { parentCommentId: 'y' }),
      imported('y', { parentCommentId: 'x' }),
      imported('elsewhere', { profileId: other }),
    ]);
    expect((await s.rootOf(page, 'c'))?.commentId).toBe('a');
    expect((await s.rootOf(page, 'orphan'))?.commentId).toBe('orphan');
    expect((await s.rootOf(page, 'x'))?.commentId).toBe('x');
    expect((await s.rootOf(page, 'y'))?.commentId).toBe('x');
    expect(await s.rootOf(page, 'elsewhere')).toBeUndefined();
    expect(await s.rootOf(page, 'none')).toBeUndefined();
  });

  it('places a site reply under its parent, or alone when the parent is not on the page', async () => {
    const { store: s } = store([
      row('root'),
      row('reply', { parentCommentId: 'root' }),
      row('cross', { parentCommentId: 'elsewhere' }),
      row('elsewhere', { profileId: other }),
      row('lost', { parentCommentId: 'gone' }),
    ]);
    expect((await s.rootOf(page, 'reply'))?.commentId).toBe('root');
    expect((await s.rootOf(page, 'cross'))?.commentId).toBe('cross');
    expect((await s.rootOf(page, 'lost'))?.commentId).toBe('lost');
  });

  it('lists an orphaned imported reply as a top-level comment, and counts it there', async () => {
    const { store: s, model } = store([
      imported('a', { tabId: 't' }),
      imported('b', { tabId: 't', parentCommentId: 'a' }),
      imported('orphan', { tabId: 't', parentCommentId: 'gone' }),
    ]);
    const page1 = await s.topLevel(page, 't');
    expect(page1?.roots.map((r) => r.commentId)).toEqual(['a', 'orphan']);
    const replies = await s.replies(page, ['a', 'orphan']);
    expect(replies.get('a')?.map((r) => r.commentId)).toEqual(['b']);
    expect(replies.get('orphan')).toEqual([]);
    const counts = await commentCounts(model as never, page);
    expect(counts.get('t')).toBe(3);
    await expect(s.replies(page, [])).resolves.toEqual(new Map());
  });

  it('lists comment ids that have versions but no row', async () => {
    const { store: s } = store([row('a')]);
    await expect(s.withoutRows(['a', 'b', 'b'])).resolves.toEqual(['b']);
    await expect(s.withoutRows([])).resolves.toEqual([]);
  });

  it('orders replies of one moment by their database id', async () => {
    const first = new Types.ObjectId('000000000000000000000001');
    const second = new Types.ObjectId('000000000000000000000002');
    const { store: s } = store([
      row('root'),
      row('r2', { _id: second, parentCommentId: 'root' }),
      row('r1', { _id: first, parentCommentId: 'root' }),
      row('later', {
        parentCommentId: 'root',
        createdAt: new Date('2026-11-02T00:00:00.000Z'),
      }),
    ]);
    const replies = await s.replies(page, ['root']);
    expect(replies.get('root')?.map((r) => r.commentId)).toEqual([
      'r1',
      'r2',
      'later',
    ]);
  });
});

describe('endTextTurn', () => {
  it('logs, never throws, when a turn cannot be ended', async () => {
    const warn = jest.fn();
    const tabModel = {
      updateOne: () => ({ exec: () => Promise.reject(new Error('down')) }),
    };
    await endTextTurn(tabModel as never, 'tab', 'id', warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('down'));
    const plain = {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is the case tested
      updateOne: () => ({ exec: () => Promise.reject('plain') }),
    };
    await endTextTurn(plain as never, 'tab', 'id', warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('plain'));
  });
});

describe('round 3', () => {
  it('asks for site replies so the partial parentCommentId index can serve them', async () => {
    const { store: s, model } = store([row('root')]);
    const find = jest.spyOn(model, 'find');
    await s.replies(page, ['root']);
    const siteQuery = find.mock.calls
      .map(([filter]) => filter as Record<string, unknown>)
      .find((filter) => filter?.source === 'native');
    // The index is partial on { $type: 'string' }: MongoDB uses it only when
    // the query names that too (measured; see comment-replies-index e2e).
    expect(siteQuery?.parentCommentId).toEqual({
      $type: 'string',
      $in: ['root'],
    });
  });
});
