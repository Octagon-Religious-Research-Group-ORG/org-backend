/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import sharp from 'sharp';
import { MAX_PICTURE_BYTES } from '../src/members/picture-processing';
import {
  createMembersApp,
  moderationLog,
  OWN_PAGES,
  OWNER,
  pictures,
} from './members-test-app';

describe('Members API (e2e)', () => {
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

  describe('the directory', () => {
    it('lists only live, listed pages for a guest, and leaks nothing', async () => {
      const { body, text } = await get('/members/directory').expect(200);
      expect(body.members.map((c: { slug: string }) => c.slug).sort()).toEqual([
        'members-page',
        'named-page',
        'open-page',
      ]);
      expect(text).not.toMatch(/LEAKED|user_owner|ownerUserId/);
      const named = body.members.find(
        (c: { slug: string }) => c.slug === 'named-page',
      );
      expect(named).toMatchObject({ access: 'name-only', hasPicture: false });
    });

    it('never lists an unlisted page, even to its owner or an admin', async () => {
      for (const user of [OWNER, 'user_admin']) {
        const { text } = await get('/members/directory', user).expect(200);
        expect(text).not.toContain('hidden-page');
        expect(text).not.toContain('waiting-page');
      }
    });
  });

  describe('a profile', () => {
    it.each(['hidden-page', 'waiting-page', 'claim-page', 'gone-page', 'nope'])(
      'gives a guest the same 404 for %s',
      async (slug) => {
        const missing = await get('/members/profiles/nope').expect(404);
        const { body } = await get(`/members/profiles/${slug}`).expect(404);
        expect(body).toEqual(missing.body);
      },
    );

    it('serves a public page to a logged-out request', async () => {
      const { body, text } = await get('/members/profiles/open-page').expect(
        200,
      );
      expect(body).toMatchObject({ access: 'full', isOwner: false });
      expect(body.bio[0].text).toBe('Synthetic bio');
      expect(text).not.toMatch(/LEAKED|user_owner/);
    });

    it('gives a guest the name of a members page and nothing else', async () => {
      const { body } = await get('/members/profiles/members-page').expect(200);
      expect(Object.keys(body).sort()).toEqual([
        'access',
        'displayName',
        'hasPicture',
        'isOwner',
        'picturePublic',
        'slug',
      ]);
      expect(body.access).toBe('name-only');
    });

    it('opens a members page to an anonymous member', async () => {
      await get('/members/profiles/members-page', 'user_anon')
        .expect(200)
        .expect((res) => expect(res.body.access).toBe('full'));
    });

    it('keeps a named-members page from an anonymous member', async () => {
      await get('/members/profiles/named-page', 'user_anon')
        .expect(200)
        .expect((res) => expect(res.body.access).toBe('name-only'));
    });

    it('shows an owner their pending page, marked as theirs', async () => {
      await get('/members/profiles/waiting-page', OWNER)
        .expect(200)
        .expect((res) =>
          expect(res.body).toMatchObject({
            access: 'full',
            isOwner: true,
            manage: { reviewStatus: 'pending' },
          }),
        );
    });

    it('takes identity only from the token', async () => {
      await get('/members/profiles/hidden-page?userId=user_owner')
        .set('X-User-Id', OWNER)
        .expect(404);
    });
  });

  describe('a picture', () => {
    it('serves a public picture with the right headers', async () => {
      const { headers, body } = await get('/members/profiles/open-page/picture')
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(headers['content-type']).toBe('image/webp');
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['cache-control']).toBe('public, no-cache');
      expect(headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(headers.etag).toBe('"file1"');
      expect(body).toEqual(Buffer.from('webp-bytes'));
    });

    it('answers 304 to a conditional request for a public picture', async () => {
      await get('/members/profiles/open-page/picture')
        .set('If-None-Match', '"file1"')
        .expect(304);
    });

    it.each([
      ['members-page', 'name-only'],
      ['named-page', 'name-only'],
      ['hidden-page', 'none'],
      ['waiting-page', 'none'],
      ['gone-page', 'none'],
    ])('refuses a guest the picture of %s (%s)', async (slug) => {
      pictures.read.mockClear();
      await get(`/members/profiles/${slug}/picture`).expect(404);
      expect(pictures.read).not.toHaveBeenCalled();
    });

    it('never stores a restricted picture anywhere', async () => {
      const { headers } = await get(
        '/members/profiles/members-page/picture',
        'user_named',
      ).expect(200);
      expect(headers['cache-control']).toBe('private, no-store');
      expect(headers.etag).toBeUndefined();
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    });

    it('keeps an owner’s unlisted picture out of every cache', async () => {
      const { headers } = await get(
        '/members/profiles/hidden-page/picture',
        OWNER,
      ).expect(200);
      expect(headers['cache-control']).toBe('private, no-store');
    });
  });

  describe('the chats panel', () => {
    it.each([[undefined], ['user_new']])(
      'hides the invite from %s',
      async (user) => {
        const { text } = await get('/members/chats', user).expect(200);
        expect(text).not.toContain('SECRETINVITE');
        expect(JSON.parse(text)).toEqual({ voting: 'hidden' });
      },
    );

    it('gives the invite to an approved member', async () => {
      await get('/members/chats', 'user_anon')
        .expect(200)
        .expect((res) => expect(res.text).toContain('SECRETINVITE'));
    });
  });

  describe('owner tools', () => {
    const write = (method: 'patch' | 'post' | 'put', path: string) =>
      request(app.getHttpServer())
        [method](`/api/v1${path}`)
        .set('Authorization', `Bearer ${OWNER}`);

    it.each([
      ['patch', '/me/member-page/visibility'],
      ['post', '/me/member-page/tabs'],
      ['put', '/me/member-page/picture'],
      ['put', '/admin/settings/voting-invite'],
    ] as const)('refuses %s %s without a login', async (method, path) => {
      await request(app.getHttpServer())
        [method](`/api/v1${path}`)
        .send({})
        .expect(401);
    });

    it('changes visibility', async () => {
      await write('patch', '/me/member-page/visibility')
        .send({ visibility: 'unlisted' })
        .expect(200)
        .expect({ visibility: 'unlisted' });
    });

    it.each([
      ['an unknown visibility', { visibility: 'friends' }],
      ['an extra field', { visibility: 'public', ownerUserId: 'x' }],
    ])('refuses %s', async (_n, body) => {
      await write('patch', '/me/member-page/visibility').send(body).expect(400);
    });

    it('adds a belief tab, and refuses one with an extra field', async () => {
      await write('post', '/me/member-page/tabs')
        .send({ title: 'God', text: 'One.' })
        .expect(201);
      await write('post', '/me/member-page/tabs')
        .send({ title: 'God', text: 'One.', reviewStatus: 'confirmed' })
        .expect(400);
    });

    it('accepts a real picture and stores the re-encoded form', async () => {
      pictures.store.mockClear();
      const png = await sharp({
        create: { width: 4, height: 4, channels: 3, background: '#123456' },
      })
        .png()
        .toBuffer();
      await write('put', '/me/member-page/picture')
        .attach('picture', png, { filename: 'a.png', contentType: 'image/png' })
        .expect(200)
        .expect({ hasPicture: true });
      expect(pictures.store).toHaveBeenCalledTimes(1);
    });

    it('refuses text that claims to be a picture', async () => {
      pictures.store.mockClear();
      await write('put', '/me/member-page/picture')
        .attach('picture', Buffer.from('<script>alert(1)</script>'), {
          filename: 'a.png',
          contentType: 'image/png',
        })
        .expect(400);
      expect(pictures.store).not.toHaveBeenCalled();
    });

    it('refuses a file over the size limit before reading it', async () => {
      await write('put', '/me/member-page/picture')
        .attach('picture', Buffer.alloc(MAX_PICTURE_BYTES + 1), {
          filename: 'big.png',
          contentType: 'image/png',
        })
        .expect(413);
    });

    it('refuses an upload with no file', async () => {
      await write('put', '/me/member-page/picture').send({}).expect(400);
    });

    it('refuses more than one file, by the file limit', async () => {
      const png = Buffer.from('x');
      const { body } = await write('put', '/me/member-page/picture')
        .attach('picture', png, 'a.png')
        .attach('picture', png, 'b.png')
        .expect(400);
      expect(body.message).toMatch(/Too many files/);
    });

    it('refuses an extra form field, by the field limit', async () => {
      pictures.store.mockClear();
      const { body } = await write('put', '/me/member-page/picture')
        .field('note', 'x')
        .attach('picture', Buffer.from('x'), 'a.png')
        .expect(400);
      expect(body.message).toMatch(/Too many fields/);
      expect(pictures.store).not.toHaveBeenCalled();
    });

    it('keeps a signed-in answer out of every cache, and a guest one out of shared caches', async () => {
      const signedIn = await get('/members/chats', 'user_anon').expect(200);
      expect(signedIn.headers['cache-control']).toBe('private, no-store');
      const owner = await write('patch', '/me/member-page/visibility')
        .send({ visibility: 'public' })
        .expect(200);
      expect(owner.headers['cache-control']).toBe('private, no-store');
      const guest = await get('/members/chats').expect(200);
      expect(guest.headers['cache-control']).toBe('no-store');
      expect(guest.headers.vary).toContain('Authorization');
    });

    it('lets a public picture stay cacheable for a signed-in viewer', async () => {
      const { headers } = await get(
        '/members/profiles/open-page/picture',
        'user_anon',
      ).expect(200);
      expect(headers['cache-control']).toBe('public, no-cache');
    });
  });

  describe('the voting invite setting', () => {
    const put = (user: string, inviteUrl: string) =>
      request(app.getHttpServer())
        .put('/api/v1/admin/settings/voting-invite')
        .set('Authorization', `Bearer ${user}`)
        .send({ inviteUrl });

    it('refuses a member who is not an admin', async () => {
      moderationLog.record.mockClear();
      await put('user_named', 'https://t.me/+abc').expect(403);
      expect(moderationLog.record).not.toHaveBeenCalled();
    });

    it('ignores a permission claim on the token', async () => {
      await put('user_named', 'https://t.me/+abc')
        .set('X-Test-Permissions', 'manage:settings')
        .expect(403);
    });

    it('counts against the account ration', async () => {
      const send = (attempt: number) =>
        put('user_admin_ration', 'https://t.me/+abc').set(
          'X-Forwarded-For',
          `203.0.113.${Math.floor(attempt / 8)}`,
        );
      for (let attempt = 0; attempt < 100; attempt++) {
        await send(attempt).expect(200);
      }
      const { body } = await send(100).expect(429);
      expect(body.code).toBe('MEMBER_WRITE_DAILY_LIMIT');
    });

    it('lets an admin set it, audited', async () => {
      moderationLog.record.mockClear();
      await put('user_admin', 'https://t.me/+abc')
        .expect(200)
        .expect({ set: true });
      expect(moderationLog.record).toHaveBeenCalledTimes(2);
    });
  });

  it('applies the write limit to adding a tab', async () => {
    const send = () =>
      request(app.getHttpServer())
        .post('/api/v1/me/member-page/tabs')
        .set('Authorization', 'Bearer user_tablimit')
        .set('X-Forwarded-For', '203.0.113.51')
        .send({ title: 'T', text: 'x' });
    OWN_PAGES.user_tablimit = OWN_PAGES.user_owner;
    for (let attempt = 0; attempt < 10; attempt++) await send().expect(201);
    await send().expect(429);
  });

  it('applies the write limit to owner tools', async () => {
    const send = () =>
      request(app.getHttpServer())
        .patch('/api/v1/me/member-page/visibility')
        .set('Authorization', 'Bearer user_ratelimit')
        .set('X-Forwarded-For', '203.0.113.50')
        .send({ visibility: 'public' });
    for (let attempt = 0; attempt < 10; attempt++) await send().expect(200);
    await send().expect(429);
  });
});
