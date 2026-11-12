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
    create: jest.fn(() => Promise.resolve('created')),
    edit: jest.fn(() => Promise.resolve('edited')),
    remove: jest.fn(() => Promise.resolve('removed')),
  };
  const suggestions = {
    suggest: jest.fn(() => Promise.resolve('suggested')),
    accept: jest.fn(() => Promise.resolve('accepted')),
    decline: jest.fn(() => Promise.resolve('declined')),
  };
  const writers = { requireWriter: jest.fn(() => Promise.resolve(writer)) };
  return {
    members,
    comments,
    suggestions,
    writers,
    reads: new CommentThreadsController(members as never, comments as never),
    writes: new CommentWritesController(
      writers as never,
      comments as never,
      suggestions as never,
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
    );
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
    expect(t.writers.requireWriter).toHaveBeenCalledTimes(5);
  });

  it('removes, accepts and declines as the token user', async () => {
    const t = setup();
    await expect(t.writes.remove(req, 'c')).resolves.toBe('removed');
    expect(t.comments.remove).toHaveBeenCalledWith('user_n', 'c');
    await expect(t.writes.accept(req, 'c')).resolves.toBe('accepted');
    expect(t.suggestions.accept).toHaveBeenCalledWith('user_n', 'c');
    await expect(t.writes.decline(req, 'c')).resolves.toBe('declined');
    expect(t.suggestions.decline).toHaveBeenCalledWith('user_n', 'c');
  });
});
