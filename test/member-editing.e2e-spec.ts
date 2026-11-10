/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { ConflictException, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { BIO_TOO_LONG } from '../src/members/member-page-editor.service';
import { STALE_EDIT_REFUSAL } from '../src/social/block-versions.service';
import { appendVersion, createMembersApp, OWNER } from './members-test-app';

describe('Members API, editing and history (e2e)', () => {
  let app: INestApplication<App>;
  const get = (path: string, user?: string) => {
    const call = request(app.getHttpServer()).get(`/api/v1${path}`);
    return user ? call.set('Authorization', `Bearer ${user}`) : call;
  };

  beforeAll(async () => {
    app = await createMembersApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('editing and history', () => {
    const send = (
      method: 'put' | 'patch' | 'delete',
      path: string,
      user = OWNER,
    ) =>
      request(app.getHttpServer())
        [method](`/api/v1/me/member-page${path}`)
        .set('Authorization', `Bearer ${user}`);

    it.each([
      ['put', '/bio'],
      ['put', '/tabs/tab_1/text'],
      ['put', '/tabs/tab_1/title'],
      ['patch', '/tabs/tab_1/position'],
      ['delete', '/tabs/tab_1'],
    ] as const)('refuses %s %s without a login', async (method, path) => {
      await request(app.getHttpServer())
        [method](`/api/v1/me/member-page${path}`)
        .send({})
        .expect(401);
    });

    it('saves a bio on top of the version the editor saw, stored nowhere', async () => {
      appendVersion.mockClear();
      const { body, headers } = await send('put', '/bio')
        .send({ text: 'A new synthetic bio.', baseSeq: 1 })
        .expect(200);
      expect(body).toEqual({ changed: true, seq: 2 });
      expect(headers['cache-control']).toBe('private, no-store');
      expect(appendVersion).toHaveBeenCalledWith({
        blockId: 'b1',
        text: 'A new synthetic bio.',
        authorUserId: OWNER,
        expectedSeq: 1,
      });
    });

    it('writes nothing for the same text', async () => {
      appendVersion.mockClear();
      await send('put', '/bio')
        .send({ text: ' Synthetic bio \n', baseSeq: 1 })
        .expect(200)
        .expect({ changed: false, seq: 1 });
      expect(appendVersion).not.toHaveBeenCalled();
    });

    it.each([
      ['no starting version', { text: 'x' }],
      ['a negative version', { text: 'x', baseSeq: -1 }],
      ['a fractional version', { text: 'x', baseSeq: 1.5 }],
      ['an empty text', { text: '', baseSeq: 1 }],
      ['an author in the body', { text: 'x', baseSeq: 1, authorUserId: 'u' }],
    ])('refuses an edit with %s', async (_name, body) => {
      await send('put', '/bio').send(body).expect(400);
    });

    it('lets a long text through to the service, which explains the limit', async () => {
      const { body } = await send('put', '/bio')
        .set('X-Forwarded-For', '203.0.113.77')
        .send({ text: 'a'.repeat(20_001), baseSeq: 1 })
        .expect(400);
      expect(body.message).toBe(BIO_TOO_LONG);
      await send('put', '/bio')
        .set('X-Forwarded-For', '203.0.113.77')
        .send({ text: 'a'.repeat(60_001), baseSeq: 1 })
        .expect(400);
    });

    it('reads a long text of 3-byte characters, over 100 kB of JSON, instead of a bare 413', async () => {
      // 35,000 three-byte characters: 105,000 bytes of UTF-8 (the default limit
      // is 102,400), and 210,000 bytes when a client escapes them as \u sequences.
      const wide = '語'.repeat(35_000);
      expect(Buffer.byteLength(JSON.stringify({ text: wide }))).toBeGreaterThan(
        100 * 1024,
      );
      for (const path of ['/bio', '/tabs/tab_1/text']) {
        const { body } = await send('put', path)
          .set('X-Forwarded-For', '203.0.113.78')
          .send({ text: wide, baseSeq: 1 })
          .expect(400);
        expect(body.message).toMatch(/longer than one save can hold/);
      }
      const escaped = JSON.stringify({ text: wide, baseSeq: 1 }).replace(
        /[\u0080-\uffff]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
      );
      expect(escaped.length).toBeGreaterThan(200_000);
      const { body } = await send('put', '/bio')
        .set('X-Forwarded-For', '203.0.113.78')
        .set('Content-Type', 'application/json')
        .send(escaped)
        .expect(400);
      expect(body.message).toBe(BIO_TOO_LONG);
    });

    it('edits a belief and its title, moves and removes it', async () => {
      await send('put', '/tabs/tab_1/text')
        .send({ text: 'Synthetic belief, edited.', baseSeq: 1 })
        .expect(200);
      await send('put', '/tabs/tab_1/title')
        .send({ title: 'Edited title', baseSeq: 2 })
        .expect(200)
        .expect({ changed: true, seq: 2 });
      await send('patch', '/tabs/tab_1/position')
        .send({ direction: 'sideways' })
        .expect(400);
      await send('delete', '/tabs/tab_1').expect(200).expect({ removed: true });
    });

    it('answers 409 with the plain message when the text moved on', async () => {
      appendVersion.mockRejectedValueOnce(
        new ConflictException(STALE_EDIT_REFUSAL),
      );
      const { body } = await send('put', '/bio')
        .send({ text: 'Another synthetic bio.', baseSeq: 1 })
        .expect(409);
      expect(body.message).toBe(STALE_EDIT_REFUSAL);
    });

    it('refuses an edit from an account with no page', async () => {
      await send('put', '/bio', 'user_nobody')
        .send({ text: 'x', baseSeq: 0 })
        .expect(404);
    });

    it('gives the owner the version to start from, and nobody else', async () => {
      const own = await get('/members/profiles/open-page', OWNER).expect(200);
      expect(own.body.revisions).toEqual({ bio: 1, tabs: {} });
      const guest = await get('/members/profiles/open-page').expect(200);
      expect(guest.body).not.toHaveProperty('revisions');
    });

    it('serves a public page history to a guest, with nothing private in it', async () => {
      const { body, text, headers } = await get(
        '/members/profiles/open-page/bio/history',
      ).expect(200);
      expect(body).toEqual({
        page: 1,
        hasMore: false,
        entries: [
          {
            seq: 1,
            savedAt: '2026-11-01T12:00:00.000Z',
            text: 'Synthetic bio',
            hash: 'ffffffffffff',
            source: 'member',
            beforeFirstEdit: false,
          },
        ],
      });
      expect(text).not.toMatch(/user_owner|authorUserId|prevHash|LEAKED|_id/);
      expect(headers['cache-control']).toBe('no-store');
      expect(headers.vary).toContain('Authorization');
      const signedIn = await get(
        '/members/profiles/open-page/tabs/tab_1/history?field=title&page=2',
        'user_anon',
      ).expect(200);
      expect(signedIn.headers['cache-control']).toBe('private, no-store');
    });

    it('answers a hidden page history exactly like a missing page', async () => {
      const missing = await get('/members/profiles/no-such-page/bio/history');
      expect(missing.status).toBe(404);
      for (const path of [
        '/members/profiles/hidden-page/bio/history',
        '/members/profiles/hidden-page/tabs/tab_1/history',
        '/members/profiles/waiting-page/bio/history',
        '/members/profiles/named-page/tabs/tab_1/history',
      ]) {
        const { status, body } = await get(path);
        expect(status).toBe(404);
        expect(body).toEqual(missing.body);
      }
    });

    it.each([
      ['a page of zero', '?page=0'],
      ['a page that is not a number', '?page=two'],
      ['an unknown field', '?field=secret'],
      ['an unknown parameter', '?author=1'],
    ])('refuses a history query with %s', async (_n, query) => {
      await get(
        `/members/profiles/open-page/tabs/tab_1/history${query}`,
      ).expect(400);
    });
  });
});
