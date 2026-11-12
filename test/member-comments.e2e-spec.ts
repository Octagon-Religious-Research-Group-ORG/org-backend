/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { U } from '../src/members/comments/comments-harness.mocks-spec';
import {
  NEEDS_APPROVED_PAGE,
  NEEDS_VERIFIED_EMAIL,
} from '../src/members/comments/comment-writers';
import { SUGGESTION_STALE } from '../src/members/comments/suggestions.service';
import { STALE_COMMENT_EDIT } from '../src/social/comment-versions.service';
import { type CommentsApp, createCommentsApp } from './comments-test-app';

describe('Comments API (e2e)', () => {
  let ctx: CommentsApp;
  let app: INestApplication<App>;
  let address = 0;
  /** Every call from its own address, so per-visitor limits stay out of the way. */
  const call = (
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    user?: string,
  ) => {
    address++;
    const req = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('X-Forwarded-For', `198.51.100.${address % 250}`)
      .set('X-Test-Address', String(address));
    return user ? req.set('Authorization', `Bearer ${user}`) : req;
  };
  const post = (user: string | undefined, body: Record<string, unknown>) =>
    call('post', '/me/comments', user).send(body);

  beforeEach(async () => {
    ctx = await createCommentsApp();
    app = ctx.app;
  });

  afterEach(async () => {
    await app.close();
  });

  describe('reading', () => {
    it('lets a guest read a public thread, with imported names, dates and quotes, stored nowhere', async () => {
      const { body, headers } = await call(
        'get',
        '/members/profiles/imported-page/comments?tab=tab_i',
      ).expect(200);
      expect(headers['cache-control']).toBe('no-store');
      expect(headers.vary).toMatch(/Authorization/);
      expect(body.comments[0]).toMatchObject({
        commentId: 'cmt_imp1',
        source: 'imported',
        author: { kind: 'imported', name: 'Synthetic Pages Author' },
        importedDate: '2020-05-06T00:00:00.000Z',
        anchorText: 'Second part',
      });
      expect(body.comments[0].replies).toHaveLength(2);
      expect(body).toMatchObject({
        viewerMayComment: false,
        viewerMaySuggest: false,
      });
      expect(JSON.stringify(body)).not.toMatch(/authorUserId|profileId|_id/);
    });

    it('gives a signed-in reader private, no-store JSON', async () => {
      const { headers } = await call(
        'get',
        '/members/profiles/open-page/comments',
        U.named,
      ).expect(200);
      expect(headers['cache-control']).toBe('private, no-store');
      expect(headers.vary).toMatch(/Authorization/);
    });

    it.each([
      ['a guest, members-only page', 'members-page', 'tab_m', undefined, 404],
      [
        'an anonymous member, members-only page',
        'members-page',
        'tab_m',
        U.anon,
        200,
      ],
      ['another member, unlisted page', 'hidden-page', 'tab_h', U.named, 404],
      ['the owner, unlisted page', 'hidden-page', 'tab_h', U.hiddenOwner, 200],
      ['an admin, unlisted page', 'hidden-page', 'tab_h', U.admin, 200],
      ['a member, pending page', 'waiting-page', 'tab_w', U.named, 404],
      ['the owner, pending page', 'waiting-page', 'tab_w', U.waiting, 200],
      ['the owner, a removed belief', 'open-page', 'tab_removed', U.owner, 404],
      ['an admin, a removed belief', 'open-page', 'tab_removed', U.admin, 404],
      ['anyone, a bad tab id', 'open-page', 'bad id!', U.named, 400],
    ])('%s', async (_name, slug, tab, user, status) => {
      await call(
        'get',
        `/members/profiles/${slug}/comments?tab=${encodeURIComponent(tab)}`,
        user,
      ).expect(status);
    });

    it('puts each tab’s visible comment count in the page', async () => {
      await post(U.named, {
        slug: 'imported-page',
        tabId: 'tab_i',
        body: 'One more.',
      }).expect(201);
      const { body } = await call(
        'get',
        '/members/profiles/imported-page',
      ).expect(200);
      expect(body.tabs[0]).toMatchObject({ commentCount: 4, textSeq: 1 });
      expect(body.pageCommentCount).toBe(1);
    });
  });

  describe('who may write', () => {
    it.each([
      ['logged out', undefined, 401, undefined],
      ['an account with no page', U.nopage, 403, NEEDS_APPROVED_PAGE],
      ['a pending page', U.waiting, 403, NEEDS_APPROVED_PAGE],
      ['an unverified email', U.unverified, 403, NEEDS_VERIFIED_EMAIL],
      ['a named member', U.named, 201, undefined],
      ['an anonymous member', U.anon, 201, undefined],
      ['an admin with no page', U.admin, 201, undefined],
    ])('%s', async (_name, user, status, message) => {
      const { body } = await post(user, {
        slug: 'open-page',
        tabId: 'tab_a',
        body: 'Synthetic.',
      }).expect(status);
      if (message) expect(body.message).toBe(message);
    });

    it.each([
      ['an unknown field', { authorUserId: 'user_x' }],
      ['a bad slug', { slug: 'no spaces' }],
      ['a missing body', { body: undefined }],
      ['an empty body', { body: '' }],
    ])('refuses %s', async (_name, change) => {
      await post(U.named, {
        slug: 'open-page',
        body: 'Synthetic.',
        ...change,
      }).expect(400);
    });

    it('refuses writing where the writer cannot read', async () => {
      await post(U.named, { slug: 'hidden-page', body: 'x' }).expect(404);
      await post(U.named, { slug: 'waiting-page', body: 'x' }).expect(404);
      await post(U.named, {
        slug: 'open-page',
        tabId: 'tab_removed',
        body: 'x',
      }).expect(404);
      await post(U.hiddenOwner, { slug: 'hidden-page', body: 'x' }).expect(201);
    });
  });

  describe('editing and removing', () => {
    it('edits with a version check, shows "edited" and a history; refuses others', async () => {
      const { body: made } = await post(U.named, {
        slug: 'open-page',
        tabId: 'tab_a',
        body: 'First.',
      }).expect(201);
      const path = `/me/comments/${made.commentId}`;
      await call('put', path, U.named)
        .send({ body: 'Second.', baseSeq: 1 })
        .expect(200)
        .expect({ changed: true, seq: 2 });
      const { body: stale } = await call('put', path, U.named)
        .send({ body: 'Third.', baseSeq: 1 })
        .expect(409);
      expect(stale.message).toBe(STALE_COMMENT_EDIT);
      for (const other of [U.anon, U.owner, U.admin]) {
        await call('put', path, other)
          .send({ body: 'Not mine.', baseSeq: 2 })
          .expect(404);
        await call('delete', path, other).expect(404);
      }
      await call('put', path).send({ body: 'x', baseSeq: 2 }).expect(401);

      const { body: thread } = await call(
        'get',
        '/members/profiles/open-page/comments?tab=tab_a',
      ).expect(200);
      expect(thread.comments[0]).toMatchObject({
        body: 'Second.',
        edited: true,
      });
      const { body: history } = await call(
        'get',
        `/members/profiles/open-page/comments/${made.commentId}/history`,
      ).expect(200);
      expect(history.entries.map((e: { seq: number }) => e.seq)).toEqual([
        2, 1,
      ]);

      await call('delete', path, U.named).expect(200).expect({ removed: true });
      const { body: after } = await call(
        'get',
        '/members/profiles/open-page/comments?tab=tab_a',
      ).expect(200);
      expect(after.comments[0]).toMatchObject({ removed: true });
      expect(after.comments[0]).not.toHaveProperty('body');
      // ORG keeps the text (plan §2b).
      expect(
        ctx.models.comments.docs.find((d) => d.commentId === made.commentId),
      ).toMatchObject({ body: 'Second.', removedBy: U.named });
      await call(
        'get',
        `/members/profiles/open-page/comments/${made.commentId}/history`,
      ).expect(404);
    });
  });

  describe('suggestions', () => {
    const suggest = (user: string | undefined, extra = {}) =>
      call('post', '/me/suggestions', user).send({
        slug: 'open-page',
        tabId: 'tab_a',
        text: 'Synthetic belief A, clearer.',
        baseSeq: 1,
        ...extra,
      });

    it('lets members suggest, but not the owner, a guest, or a pending page', async () => {
      await suggest(undefined).expect(401);
      await suggest(U.waiting).expect(403);
      await suggest(U.nopage).expect(403);
      await suggest(U.owner).expect(400);
      await suggest(U.anon).expect(201);
    });

    it('accepts with one click by the owner only, and records the origin', async () => {
      const { body: made } = await suggest(U.named).expect(201);
      const accept = `/me/member-page/suggestions/${made.commentId}/accept`;
      for (const other of [U.named, U.admin, U.anon]) {
        await call('post', accept, other).expect(404);
      }
      await call('post', accept).expect(401);
      await call('post', accept, U.owner)
        .expect(201)
        .expect({ accepted: true, seq: 2 });
      const { body: history } = await call(
        'get',
        '/members/profiles/open-page/tabs/tab_a/history',
      ).expect(200);
      expect(history.entries[0]).toMatchObject({
        text: 'Synthetic belief A, clearer.',
        fromSuggestion: {
          commentId: made.commentId,
          author: { kind: 'member', displayName: 'Name of named-writer' },
        },
      });
      const { body: thread } = await call(
        'get',
        '/members/profiles/open-page/comments?tab=tab_a',
        U.owner,
      ).expect(200);
      expect(thread.comments[0].suggestion).toMatchObject({
        status: 'accepted',
      });
    });

    it('refuses a stale accept with a clear 409, and lets the owner decline it', async () => {
      const { body: made } = await suggest(U.named).expect(201);
      await call('put', '/me/member-page/tabs/tab_a/text', U.owner)
        .send({ text: 'The owner rewrote it.', baseSeq: 1 })
        .expect(200);
      const { body } = await call(
        'post',
        `/me/member-page/suggestions/${made.commentId}/accept`,
        U.owner,
      ).expect(409);
      expect(body.message).toBe(SUGGESTION_STALE);
      await call(
        'post',
        `/me/member-page/suggestions/${made.commentId}/decline`,
        U.owner,
      )
        .expect(201)
        .expect({ declined: true });
    });

    it('takes a long suggestion only with a token', async () => {
      const wide = '語'.repeat(19_000);
      const escaped = JSON.stringify({
        slug: 'open-page',
        tabId: 'tab_a',
        text: wide,
        baseSeq: 1,
      }).replace(
        /[\u0080-￿]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
      );
      expect(escaped.length).toBeGreaterThan(100 * 1024);
      await call('post', '/me/suggestions', U.named)
        .set('Content-Type', 'application/json')
        .send(escaped)
        .expect(201);
      await call('post', '/me/suggestions')
        .set('Content-Type', 'application/json')
        .send(escaped)
        .expect(413);
    });
  });

  it('rations writes per visitor', async () => {
    const fixed = () =>
      request(app.getHttpServer())
        .post('/api/v1/me/comments')
        .set('X-Forwarded-For', '203.0.113.200')
        .set('Authorization', `Bearer ${U.named}`)
        .send({ slug: 'open-page', body: 'Again.' });
    for (let i = 0; i < 10; i++) await fixed().expect(201);
    await fixed().expect(429);
  });
});
