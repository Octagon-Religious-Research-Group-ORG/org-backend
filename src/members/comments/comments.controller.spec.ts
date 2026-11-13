import {
  CommentThreadsController,
  CommentWritesController,
} from './comments.controller';

const viewer = { kind: 'named-member', userId: 'user_n', isAdmin: false };
const writer = { ...viewer, writesAsAdmin: false };
const req = { auth: { payload: { sub: 'user_n' } }, headers: {} } as never;

function setup() {
  const members = { resolveViewer: jest.fn(() => Promise.resolve(viewer)) };
  const comments = {
    thread: jest.fn(() => Promise.resolve('thread')),
    history: jest.fn(() => Promise.resolve('history')),
    create: jest.fn(() => Promise.resolve({ commentId: 'c' })),
    edit: jest.fn(() => Promise.resolve({ changed: true })),
    remove: jest.fn(() => Promise.resolve({ removed: true })),
    viewOne: jest.fn((commentId: string) =>
      Promise.resolve(commentId === 'gone' ? undefined : { view: commentId }),
    ),
  };
  const suggestions = {
    suggest: jest.fn(() => Promise.resolve({ commentId: 'c' })),
    accept: jest.fn(() => Promise.resolve({ accepted: true })),
    decline: jest.fn(() => Promise.resolve({ declined: true })),
  };
  const writers = {
    requireWriter: jest.fn(() => Promise.resolve(writer)),
    writeStatus: jest.fn(() => Promise.resolve({ mayComment: true })),
  };
  return {
    members,
    comments,
    suggestions,
    writers,
    reads: new CommentThreadsController(
      members as never,
      comments as never,
      writers as never,
    ),
    writes: new CommentWritesController(
      writers as never,
      comments as never,
      suggestions as never,
      members as never,
    ),
  };
}

describe('comment controllers', () => {
  it('reads threads and histories as the resolved viewer', async () => {
    const t = setup();
    await expect(
      t.reads.thread(req, 'some-page', { tab: 'tab_a', after: 'cmt_1' }),
    ).resolves.toBe('thread');
    expect(t.comments.thread).toHaveBeenCalledWith(
      'some-page',
      viewer,
      'tab_a',
      'cmt_1',
      { mayComment: true },
    );
    expect(t.writers.writeStatus).toHaveBeenCalledWith(viewer);
    await expect(
      t.reads.history(req, 'some-page', 'cmt_1', { page: 2 }),
    ).resolves.toBe('history');
    expect(t.comments.history).toHaveBeenCalledWith(
      'some-page',
      'cmt_1',
      viewer,
      2,
    );
  });

  it('writes only as a checked writer, passing just the named fields', async () => {
    const t = setup();
    await t.writes.create(req, { slug: 's', body: 'b' });
    expect(t.comments.create).toHaveBeenLastCalledWith(writer, {
      slug: 's',
      body: 'b',
    });
    await t.writes.create(req, {
      slug: 's',
      body: 'b',
      tabId: 't',
      parentCommentId: 'p',
    });
    expect(t.comments.create).toHaveBeenLastCalledWith(writer, {
      slug: 's',
      body: 'b',
      tabId: 't',
      parentCommentId: 'p',
    });
    await t.writes.create(req, {
      slug: 's',
      body: 'b',
      tabId: 't',
      stance: 'agree',
    });
    expect(t.comments.create).toHaveBeenLastCalledWith(writer, {
      slug: 's',
      body: 'b',
      tabId: 't',
      stance: 'agree',
    });
    await t.writes.edit(req, 'cmt_1', { body: 'b', baseSeq: 3 });
    expect(t.comments.edit).toHaveBeenCalledWith(writer, 'cmt_1', 'b', 3);
    await t.writes.suggest(req, {
      slug: 's',
      tabId: 't',
      text: 'x',
      baseSeq: 1,
    });
    expect(t.suggestions.suggest).toHaveBeenLastCalledWith(writer, {
      slug: 's',
      tabId: 't',
      text: 'x',
      baseSeq: 1,
    });
    await t.writes.suggest(req, {
      slug: 's',
      tabId: 't',
      text: 'x',
      baseSeq: 1,
      note: 'n',
    });
    expect(t.suggestions.suggest).toHaveBeenLastCalledWith(
      writer,
      expect.objectContaining({ note: 'n' }),
    );
    expect(t.writers.requireWriter).toHaveBeenCalledTimes(6);
  });

  it('removes, accepts and declines as the token user', async () => {
    const t = setup();
    await expect(t.writes.remove(req, 'c')).resolves.toEqual({
      removed: true,
      comment: { view: 'c' },
    });
    expect(t.comments.remove).toHaveBeenCalledWith('user_n', 'c');
    await expect(t.writes.accept(req, 'c')).resolves.toEqual({
      accepted: true,
      comment: { view: 'c' },
    });
    expect(t.suggestions.accept).toHaveBeenCalledWith('user_n', 'c');
    // The owner decides: the view says so.
    expect(t.comments.viewOne).toHaveBeenLastCalledWith('c', viewer, true);
    await expect(t.writes.decline(req, 'gone')).resolves.toEqual({
      declined: true,
    });
    expect(t.suggestions.decline).toHaveBeenCalledWith('user_n', 'gone');
  });
});
