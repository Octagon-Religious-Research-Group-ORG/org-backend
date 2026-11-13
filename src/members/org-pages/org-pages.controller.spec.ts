import type { AuthenticatedRequest } from '../../auth/auth.types';
import type { CommentWritersService } from '../comments/comment-writers';
import type { CommentsService } from '../comments/comments.service';
import type { MembersService } from '../members.service';
import type { VotesService } from '../votes/votes.service';
import type { OrgPagesService } from './org-pages.service';
import {
  OrgPageReactionsController,
  OrgPageReactionWritesController,
} from './org-pages.controller';

const request = {
  auth: { payload: { sub: 'user_v' } },
  headers: {},
} as unknown as AuthenticatedRequest;

function setup(view: unknown = { commentId: 'cmt_1' }) {
  const viewer = { kind: 'named-member', userId: 'user_v', isAdmin: false };
  const writer = { ...viewer, writesAsAdmin: false };
  const members = {
    resolveViewer: jest.fn(() => Promise.resolve(viewer)),
  } as unknown as MembersService;
  const votes = {
    orgPageVotes: jest.fn(() => Promise.resolve('votes')),
    castOnOrgPage: jest.fn(() => Promise.resolve('cast')),
    withdrawOnOrgPage: jest.fn(() => Promise.resolve('withdrawn')),
  };
  const comments = {
    orgThread: jest.fn(() => Promise.resolve('thread')),
    orgHistory: jest.fn(() => Promise.resolve('history')),
    createOnOrgPage: jest.fn(() =>
      Promise.resolve({ commentId: 'cmt_1', seq: 1 }),
    ),
    viewOne: jest.fn(() => Promise.resolve(view)),
  };
  const writers = {
    writeStatus: jest.fn(() => Promise.resolve({ mayComment: true })),
    requireWriter: jest.fn(() => Promise.resolve(writer)),
  };
  const orgPages = {
    find: jest.fn(() => Promise.resolve({ pageId: 'about' })),
  };
  const deps = [
    members,
    votes as unknown as VotesService,
    comments as unknown as CommentsService,
    writers as unknown as CommentWritersService,
  ] as const;
  return {
    viewer,
    writer,
    votes,
    comments,
    reads: new OrgPageReactionsController(...deps),
    writes: new OrgPageReactionWritesController(
      ...deps,
      orgPages as unknown as OrgPagesService,
    ),
    orgPages,
    writers,
  };
}

describe('ORG page reaction controllers (Chunk 10b)', () => {
  it('reads votes, a thread page and a comment’s history for the resolved viewer', async () => {
    const { viewer, votes, comments, reads } = setup();
    await expect(reads.votesOn(request, 'about')).resolves.toBe('votes');
    expect(votes.orgPageVotes).toHaveBeenCalledWith(viewer, 'about');
    await expect(
      reads.thread(request, 'about', { after: 'cmt_0' }),
    ).resolves.toBe('thread');
    expect(comments.orgThread).toHaveBeenCalledWith('about', viewer, 'cmt_0', {
      mayComment: true,
    });
    await expect(
      reads.history(request, 'about', 'cmt_1', { page: 2 }),
    ).resolves.toBe('history');
    expect(comments.orgHistory).toHaveBeenCalledWith(
      'about',
      'cmt_1',
      2,
      viewer,
    );
  });

  it('passes only the validated fields to the writes', async () => {
    const { viewer, writer, votes, comments, writes } = setup();
    await expect(
      writes.cast(request, 'about', {
        value: 'agree',
        baseSeq: 3,
        extra: 'dropped',
      } as never),
    ).resolves.toBe('cast');
    expect(votes.castOnOrgPage).toHaveBeenCalledWith(viewer, {
      pageId: 'about',
      value: 'agree',
      baseSeq: 3,
    });
    await expect(writes.withdraw(request, 'about')).resolves.toBe('withdrawn');
    expect(votes.withdrawOnOrgPage).toHaveBeenCalledWith(
      { ...viewer, userId: 'user_v' },
      'about',
    );

    await expect(
      writes.create(request, 'about', { body: 'Synthetic.' }),
    ).resolves.toEqual({
      commentId: 'cmt_1',
      seq: 1,
      comment: { commentId: 'cmt_1' },
    });
    expect(comments.createOnOrgPage).toHaveBeenLastCalledWith(writer, {
      pageId: 'about',
      body: 'Synthetic.',
    });
    await writes.create(request, 'about', {
      body: 'A reply.',
      parentCommentId: 'cmt_0',
      stance: 'agree',
    });
    expect(comments.createOnOrgPage).toHaveBeenLastCalledWith(writer, {
      pageId: 'about',
      body: 'A reply.',
      parentCommentId: 'cmt_0',
      stance: 'agree',
    });
    expect(comments.viewOne).toHaveBeenCalledWith('cmt_1', writer);
  });

  it('looks the page up before it checks the writer (review MEDIUM 1)', async () => {
    const { writes, orgPages, writers, comments } = setup();
    orgPages.find.mockRejectedValueOnce(new Error('not found'));
    await expect(
      writes.create(request, 'nope', { body: 'Synthetic.' }),
    ).rejects.toThrow('not found');
    expect(writers.requireWriter).not.toHaveBeenCalled();
    expect(comments.createOnOrgPage).not.toHaveBeenCalled();
  });

  it('answers a write without the comment when it cannot be shown', async () => {
    const { writes } = setup(null);
    await expect(
      writes.create(request, 'about', { body: 'Synthetic.' }),
    ).resolves.toEqual({ commentId: 'cmt_1', seq: 1 });
  });
});
