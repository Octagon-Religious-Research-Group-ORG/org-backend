/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
// Votes and comments on ORG's own pages (Chunk 10b) through the real
// controllers, validation pipe, guards, throttles and services, over
// in-memory models. Synthetic data only.
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { U } from '../src/members/comments/comments-harness.mocks-spec';
import { ORG_PAGE_NOT_FOUND } from '../src/members/org-pages/org-pages.service';
import { ANONYMOUS_VOTING_OFF } from '../src/members/votes/voters.service';
import { ORG_PAGE_VOTE_STALE } from '../src/members/votes/votes.service';
import { type CommentsApp, createCommentsApp } from './comments-test-app';

describe('ORG page votes and comments API (e2e)', () => {
  let ctx: CommentsApp;
  let app: INestApplication<App>;
  let address = 0;
  const call = (
    method: 'get' | 'put' | 'delete' | 'post',
    path: string,
    user?: string,
  ) => {
    address++;
    const req = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('Origin', 'http://localhost')
      .set('X-Forwarded-For', `198.51.100.${address % 250}`);
    return user ? req.set('Authorization', `Bearer ${user}`) : req;
  };

  beforeEach(async () => {
    ctx = await createCommentsApp();
    app = ctx.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('shows a guest the counts and the thread, cached by no one', async () => {
    const votes = await call('get', '/members/org-pages/about/votes').expect(
      200,
    );
    expect(votes.headers['cache-control']).toBe('no-store');
    expect(votes.headers.vary).toMatch(/Origin/);
    expect(votes.headers.vary).toMatch(/Authorization/);
    expect(votes.body).toEqual({
      pageId: 'about',
      revision: 1,
      votes: {
        agree: 0,
        disagree: 0,
        earlierWording: 0,
        mayVote: false,
        viewerVoteBlock: 'sign-in',
      },
    });
    const thread = await call(
      'get',
      '/members/org-pages/about/comments',
    ).expect(200);
    expect(thread.headers['cache-control']).toBe('no-store');
    expect(thread.body).toEqual({
      comments: [],
      viewerMayComment: false,
      viewerWriteBlock: 'sign-in',
      viewerMaySuggest: false,
    });
  });

  it('answers the same quiet 404 for an unknown or unpublished page', async () => {
    for (const path of [
      '/members/org-pages/nope/votes',
      '/members/org-pages/legal/votes',
      '/members/org-pages/legal/comments',
      '/members/org-pages/legal/comments/cmt_x/history',
    ]) {
      for (const user of [undefined, U.named]) {
        const { body } = await call('get', path, user).expect(404);
        expect(body.message).toBe(ORG_PAGE_NOT_FOUND);
      }
    }
    const { body } = await call('put', '/me/org-pages/legal/vote', U.named)
      .send({ value: 'agree', baseSeq: 1 })
      .expect(404);
    expect(body.message).toBe(ORG_PAGE_NOT_FOUND);
    await call('post', '/me/org-pages/nope/comments', U.named)
      .send({ body: 'Lost.' })
      .expect(404);
    await call('delete', '/me/org-pages/nope/vote', U.named).expect(404);
  });

  it('answers an id that is not an ORG page with 404 before reading the request at all (round 2, N3)', async () => {
    const writes: Array<
      ['post' | 'put' | 'delete', string, Record<string, unknown> | undefined]
    > = [
      ['post', '/me/org-pages/nope/comments', { body: '' }],
      ['post', '/me/org-pages/nope/comments', {}],
      ['post', '/me/org-pages/nope/comments', { body: 'x', stance: 'maybe' }],
      ['put', '/me/org-pages/nope/vote', { value: 'perhaps' }],
      ['put', '/me/org-pages/nope/vote', undefined],
      ['delete', '/me/org-pages/nope/vote', undefined],
    ];
    for (const user of [undefined, U.named, U.nopage]) {
      for (const [method, path, payload] of writes) {
        const req = call(method, path, user);
        const { body } = await (payload ? req.send(payload) : req).expect(404);
        expect(body.message).toBe(ORG_PAGE_NOT_FOUND);
      }
      for (const path of [
        '/members/org-pages/nope/comments?after=not%20an%20id',
        '/members/org-pages/nope/comments?tab=tab_a',
        '/members/org-pages/nope/comments/cmt_x/history?page=0',
      ]) {
        const { body } = await call('get', path, user).expect(404);
        expect(body.message).toBe(ORG_PAGE_NOT_FOUND);
      }
    }
    // A known page still checks the request as before.
    await call('post', '/me/org-pages/about/comments', U.named)
      .send({ body: '' })
      .expect(400);
  });

  it('answers an unknown page with 404 before checking the writer or the text (review MEDIUM 1)', async () => {
    const noRights = await call('post', '/me/org-pages/nope/comments', U.nopage)
      .send({ body: 'Not yet a member.' })
      .expect(404);
    expect(noRights.body.message).toBe(ORG_PAGE_NOT_FOUND);
    const blank = await call('post', '/me/org-pages/legal/comments', U.named)
      .send({ body: ' ' })
      .expect(404);
    expect(blank.body.message).toBe(ORG_PAGE_NOT_FOUND);
    // On a published page the same requests are refused for what they are.
    await call('post', '/me/org-pages/about/comments', U.nopage)
      .send({ body: 'Not yet a member.' })
      .expect(403);
    await call('post', '/me/org-pages/about/comments', U.named)
      .send({ body: ' ' })
      .expect(400);
  });

  it('votes, comments with a stance, edits, and keeps it all off the agreed list', async () => {
    const cast = await call('put', '/me/org-pages/about/vote', U.named)
      .send({ value: 'agree', baseSeq: 1 })
      .expect(200);
    expect(cast.headers['cache-control']).toBe('private, no-store');
    expect(cast.body.votes).toMatchObject({ agree: 1, myVote: 'agree' });
    await call('put', '/me/org-pages/about/vote', U.owner)
      .send({ value: 'agree', baseSeq: 1 })
      .expect(200);

    const posted = await call('post', '/me/org-pages/about/comments', U.named)
      .send({ body: 'Synthetic agreement.', stance: 'agree' })
      .expect(201);
    expect(posted.body.comment).toMatchObject({
      body: 'Synthetic agreement.',
      stance: 'agree',
      mine: true,
    });
    const edited = await call(
      'put',
      `/me/comments/${posted.body.commentId}`,
      U.named,
    )
      .send({ body: 'Synthetic agreement, edited.', baseSeq: 1 })
      .expect(200);
    expect(edited.body).toMatchObject({ changed: true, seq: 2 });
    const history = await call(
      'get',
      `/members/org-pages/about/comments/${posted.body.commentId}/history`,
    ).expect(200);
    expect(history.body.entries).toHaveLength(2);

    const agreed = await call('get', '/members/agreed-beliefs').expect(200);
    expect(agreed.body.beliefs).toEqual([]);

    await call('delete', '/me/org-pages/about/vote', U.named).expect(200);
    const after = await call(
      'get',
      '/members/org-pages/about/votes',
      U.named,
    ).expect(200);
    expect(after.body.votes).toMatchObject({ agree: 1, mayVote: true });
    expect(after.body.votes).not.toHaveProperty('myVote');
  });

  it('refuses a stale revision, an anonymous vote while off, and fields it does not know', async () => {
    const stale = await call('put', '/me/org-pages/research/vote', U.named)
      .send({ value: 'agree', baseSeq: 1 })
      .expect(409);
    expect(stale.body.message).toBe(ORG_PAGE_VOTE_STALE);
    const anon = await call('put', '/me/org-pages/research/vote', U.anon)
      .send({ value: 'agree', baseSeq: 2 })
      .expect(403);
    expect(anon.body.message).toBe(ANONYMOUS_VOTING_OFF);
    await call('put', '/me/org-pages/research/vote', U.named)
      .send({ value: 'agree', baseSeq: 2, tabId: 'tab_a' })
      .expect(400);
    await call('get', '/members/org-pages/about/comments?tab=tab_a').expect(
      400,
    );
    await call('put', '/me/org-pages/about/vote')
      .send({ value: 'agree', baseSeq: 1 })
      .expect(401);
    await call('post', '/me/org-pages/about/comments', U.nopage)
      .send({ body: 'Not yet a member.' })
      .expect(403);
  });
});
