import { Types } from 'mongoose';
import { fakeModel } from '../../test-support/fake-model.mocks-spec';
import { endTextTurn } from '../tab-text-turns';
import { CommentStore } from './comment-store';
import { MAX_THREAD_DEPTH } from './comment-threads';

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
  it('walks to the top-level comment, stopping at a missing parent, another page, or a loop', async () => {
    const { store: s } = store([
      row('a'),
      row('b', { parentCommentId: 'a' }),
      row('c', { parentCommentId: 'b' }),
      row('orphan', { parentCommentId: 'gone' }),
      row('cross', { parentCommentId: 'elsewhere' }),
      row('elsewhere', { profileId: other }),
      row('x', { parentCommentId: 'y' }),
      row('y', { parentCommentId: 'x' }),
    ]);
    expect((await s.rootOf(page, 'c'))?.commentId).toBe('a');
    expect((await s.rootOf(page, 'orphan'))?.commentId).toBe('orphan');
    expect((await s.rootOf(page, 'cross'))?.commentId).toBe('cross');
    expect((await s.rootOf(page, 'x'))?.commentId).toBe('y');
    expect(await s.rootOf(page, 'elsewhere')).toBeUndefined();
    expect(await s.rootOf(page, 'none')).toBeUndefined();
  });

  it('stops after MAX_THREAD_DEPTH parents', async () => {
    const chain = Array.from({ length: MAX_THREAD_DEPTH + 3 }, (_, i) =>
      row(`n${i}`, i > 0 ? { parentCommentId: `n${i - 1}` } : {}),
    );
    const { store: s } = store(chain);
    expect((await s.rootOf(page, `n${MAX_THREAD_DEPTH + 2}`))?.commentId).toBe(
      'n2',
    );
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
