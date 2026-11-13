/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
// The votes API (Chunk 10) through the real controllers, validation pipe,
// guards, throttles and services, over in-memory models. Synthetic data only.
import type { INestApplication } from '@nestjs/common';
import { Types } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClerkUserInfoService } from '../src/auth/clerk-user-info.service';
import { CANNOT_CHECK_ACCOUNT } from '../src/members/comments/comment-writers';
import { STANCE_NEEDS_VOTE } from '../src/members/comments/comments.service';
import { U } from '../src/members/comments/comments-harness.mocks-spec';
import {
  ANONYMOUS_VOTING_OFF,
  NEEDS_APPROVED_PAGE_TO_VOTE,
  OWN_BELIEF,
} from '../src/members/votes/voters.service';
import { VOTE_STALE } from '../src/members/votes/votes.service';
import { type CommentsApp, createCommentsApp } from './comments-test-app';

describe('Votes API (e2e)', () => {
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
      .set('X-Forwarded-For', `203.0.113.${address % 250}`);
    return user ? req.set('Authorization', `Bearer ${user}`) : req;
  };
  const vote = (user: string | undefined, body: Record<string, unknown>) =>
    call('put', '/me/votes', user).send(body);
  const agreeA = {
    slug: 'open-page',
    tabId: 'tab_a',
    value: 'agree',
    baseSeq: 1,
  };

  const addMember = (userId: string, extra: Record<string, unknown> = {}) =>
    ctx.models.profiles.docs.push({
      _id: new Types.ObjectId(),
      slug: `page-${userId.replace(/_/g, '-')}`,
      displayName: `Name of ${userId}`,
      visibility: 'public',
      reviewStatus: 'approved',
      anonymous: false,
      ownerUserId: userId,
      imageIds: [],
      contacts: [],
      ...extra,
    });

  beforeEach(async () => {
    ctx = await createCommentsApp();
    app = ctx.app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('casts a vote and answers with the belief’s counts, stored nowhere', async () => {
    const { body, headers } = await vote(U.named, agreeA).expect(200);
    expect(headers['cache-control']).toBe('private, no-store');
    expect(body).toEqual({
      tabId: 'tab_a',
      textSeq: 1,
      votes: {
        agree: 1,
        disagree: 0,
        earlierWording: 0,
        myVote: 'agree',
        mayVote: true,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/user_|voterUserId|historySeq/);
  });

  it('puts each belief’s votes in the page, no-store and varied by Origin and Authorization', async () => {
    await vote(U.named, agreeA).expect(200);
    const { body, headers } = await call(
      'get',
      '/members/profiles/open-page',
    ).expect(200);
    expect(headers['cache-control']).toBe('no-store');
    expect(headers.vary).toMatch(/Origin/);
    expect(headers.vary).toMatch(/Authorization/);
    expect(body.tabs[0]).toMatchObject({
      tabId: 'tab_a',
      votes: {
        agree: 1,
        disagree: 0,
        mayVote: false,
        viewerVoteBlock: 'sign-in',
      },
    });
    const mine = await call('get', '/members/profiles/open-page', U.named);
    expect(mine.headers['cache-control']).toBe('private, no-store');
    expect(mine.body.tabs[0].votes).toMatchObject({ myVote: 'agree' });
  });

  it.each([
    ['no value', { slug: 'open-page', tabId: 'tab_a', baseSeq: 1 }],
    ['a value that is not a vote', { ...agreeA, value: 'maybe' }],
    ['no baseSeq', { slug: 'open-page', tabId: 'tab_a', value: 'agree' }],
    ['a negative baseSeq', { ...agreeA, baseSeq: -1 }],
    ['a bad page address', { ...agreeA, slug: 'bad slug!' }],
    ['a bad belief id', { ...agreeA, tabId: 'bad id!' }],
    ['an unknown field', { ...agreeA, voterUserId: 'user_other' }],
  ])('answers 400 for %s', async (_name, body) => {
    await vote(U.named, body).expect(400);
    expect(ctx.models.votes.docs).toHaveLength(0);
  });

  it('answers 401 without a sign-in', async () => {
    await vote(undefined, agreeA).expect(401);
  });

  it.each([
    [U.admin, NEEDS_APPROVED_PAGE_TO_VOTE],
    [U.anon, ANONYMOUS_VOTING_OFF],
    [U.owner, OWN_BELIEF],
  ])('answers 403 to %s', async (user, message) => {
    const { body } = await vote(user, agreeA).expect(403);
    expect(body.message).toBe(message);
  });

  it('answers 409 for a vote on a wording that is no longer current', async () => {
    const { body } = await vote(U.named, { ...agreeA, baseSeq: 5 }).expect(409);
    expect(body.message).toBe(VOTE_STALE);
  });

  it('answers 404 for a removed belief or a page the voter may not read', async () => {
    await vote(U.named, { ...agreeA, tabId: 'tab_removed' }).expect(404);
    await vote(U.named, {
      ...agreeA,
      slug: 'hidden-page',
      tabId: 'tab_h',
    }).expect(404);
  });

  it('answers 503 when Clerk is down, and the page says it cannot check', async () => {
    app.get(ClerkUserInfoService).getIdentity = () =>
      Promise.reject(new Error('Clerk down'));
    const { body } = await vote(U.named, agreeA).expect(503);
    expect(body.message).toBe(CANNOT_CHECK_ACCOUNT);
    const page = await call('get', '/members/profiles/open-page', U.named);
    expect(page.body.tabs[0].votes.viewerVoteBlock).toBe('cannot-check');
  });

  it('withdraws, and a double click never makes two votes', async () => {
    const both = await Promise.all([
      vote(U.named, agreeA),
      vote(U.named, agreeA),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual(
      both.some((r) => r.status === 409) ? [200, 409] : [200, 200],
    );
    expect(ctx.models.votes.docs).toHaveLength(1);
    const { body } = await call('delete', '/me/votes', U.named)
      .send({ slug: 'open-page', tabId: 'tab_a' })
      .expect(200);
    expect(body).toMatchObject({ withdrawn: true, votes: { agree: 0 } });
    await call('delete', '/me/votes', U.named)
      .send({ slug: 'open-page' })
      .expect(400);
    await call('delete', '/me/votes')
      .send({ slug: 'open-page', tabId: 'tab_a' })
      .expect(401);
  });

  it('answers a withdrawal identically whether or not the page exists or may be read (fix round 1, MEDIUM 2)', async () => {
    const answers: Array<{ status: number; body: unknown; cache: unknown }> =
      [];
    for (const [slug, tabId] of [
      ['no-such-page', 'tab_a'],
      ['hidden-page', 'tab_h'],
      ['waiting-page', 'tab_w'],
      ['gone-page', 'tab_x'],
    ]) {
      const { status, body, headers } = await call(
        'delete',
        '/me/votes',
        U.named,
      ).send({ slug, tabId });
      answers.push({ status, body, cache: headers['cache-control'] });
    }
    for (const answer of answers) {
      expect(answer).toEqual({
        status: 200,
        body: { withdrawn: true },
        cache: 'private, no-store',
      });
    }
  });

  it('lets an admin turn anonymous voting on, which counts anonymous votes at once', async () => {
    await call('get', '/admin/settings/vote-eligibility', U.named).expect(403);
    const read = await call(
      'get',
      '/admin/settings/vote-eligibility',
      U.admin,
    ).expect(200);
    expect(read.headers['cache-control']).toBe('private, no-store');
    expect(read.body).toEqual({ anonymousMayVote: false });
    await call('put', '/admin/settings/vote-eligibility', U.admin)
      .send({ anonymousMayVote: 'yes' })
      .expect(400);
    await call('put', '/admin/settings/vote-eligibility', U.named)
      .send({ anonymousMayVote: true })
      .expect(403);
    await call('put', '/admin/settings/vote-eligibility', U.admin)
      .send({ anonymousMayVote: true })
      .expect(200, { anonymousMayVote: true });

    await vote(U.anon, agreeA).expect(200);
    addMember('user_second');
    await vote('user_second', agreeA).expect(200);
    const listed = await call('get', '/members/agreed-beliefs').expect(200);
    expect(listed.body.beliefs.map((b: { tabId: string }) => b.tabId)).toEqual([
      'tab_a',
    ]);

    await call('put', '/admin/settings/vote-eligibility', U.admin)
      .send({ anonymousMayVote: false })
      .expect(200);
    const after = await call('get', '/members/agreed-beliefs').expect(200);
    expect(after.body.beliefs).toEqual([]);
    expect(ctx.models.votes.docs).toHaveLength(2);
  });

  it('serves the Beliefs page list to guests, no-store, and refuses a bad cursor', async () => {
    addMember('user_second');
    await vote(U.named, agreeA).expect(200);
    await vote('user_second', agreeA).expect(200);
    const { body, headers } = await call(
      'get',
      '/members/agreed-beliefs',
    ).expect(200);
    expect(headers['cache-control']).toBe('no-store');
    expect(headers.vary).toMatch(/Origin/);
    expect(headers.vary).toMatch(/Authorization/);
    expect(body).toEqual({
      beliefs: [
        expect.objectContaining({
          slug: 'open-page',
          tabId: 'tab_a',
          author: { displayName: 'Name of open-page', slug: 'open-page' },
          votes: expect.objectContaining({
            agree: 2,
            viewerVoteBlock: 'sign-in',
          }),
        }),
      ],
      viewerMayComment: false,
      viewerWriteBlock: 'sign-in',
    });
    await call('get', '/members/agreed-beliefs?after=nonsense').expect(400);
    await call('get', '/members/agreed-beliefs?after=2.0.tab_a').expect(200, {
      beliefs: [],
      viewerMayComment: false,
      viewerWriteBlock: 'sign-in',
    });
  });

  it('posts "agree and comment" with its badge, and refuses a badge without the vote', async () => {
    const { body } = await call('post', '/me/comments', U.named)
      .send({
        slug: 'open-page',
        tabId: 'tab_a',
        body: 'Why.',
        stance: 'agree',
      })
      .expect(409);
    expect(body.message).toBe(STANCE_NEEDS_VOTE);
    await call('post', '/me/comments', U.named)
      .send({
        slug: 'open-page',
        tabId: 'tab_a',
        body: 'Why.',
        stance: 'maybe',
      })
      .expect(400);
    await vote(U.named, agreeA).expect(200);
    const made = await call('post', '/me/comments', U.named)
      .send({
        slug: 'open-page',
        tabId: 'tab_a',
        body: 'Why.',
        stance: 'agree',
      })
      .expect(201);
    expect(made.body.comment).toMatchObject({ stance: 'agree' });
  });
});
