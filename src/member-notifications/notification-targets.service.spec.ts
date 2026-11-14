import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import type { NotificationKind } from './notification-kinds';
import {
  FALLBACK_PATH,
  NotificationTargets,
  type Recipient,
} from './notification-targets.service';

const OPEN = new Types.ObjectId();
const MEMBERS_ONLY = new Types.ObjectId();
const HIDDEN = new Types.ObjectId();
const ABOUT = new Types.ObjectId();

function build() {
  const profiles = fakeModel([
    {
      _id: OPEN,
      slug: 'open-page',
      visibility: 'public',
      ownerUserId: 'user_owner',
    },
    {
      _id: MEMBERS_ONLY,
      slug: 'members-page',
      visibility: 'members',
      ownerUserId: 'user_m',
    },
    {
      _id: HIDDEN,
      slug: 'hidden-page',
      visibility: 'unlisted',
      ownerUserId: 'user_h',
    },
    {
      slug: 'mine',
      visibility: 'public',
      ownerUserId: 'user_named',
      reviewStatus: 'approved',
    },
    {
      slug: 'nick',
      visibility: 'public',
      ownerUserId: 'user_anon',
      anonymous: true,
    },
    {
      slug: 'waiting',
      visibility: 'public',
      ownerUserId: 'user_pending',
      reviewStatus: 'pending',
    },
  ]);
  const comments = fakeModel([
    {
      commentId: 'c_ok',
      profileId: OPEN,
      tabId: 'tab_a',
      bodySeq: 1,
      source: 'native',
    },
    {
      commentId: 'c_members',
      profileId: MEMBERS_ONLY,
      bodySeq: 1,
      source: 'native',
    },
    {
      commentId: 'c_hidden',
      profileId: OPEN,
      bodySeq: 1,
      source: 'native',
      moderation: 'hidden',
    },
    {
      commentId: 'c_removed_mod',
      profileId: OPEN,
      bodySeq: 1,
      source: 'native',
      moderation: 'removed',
    },
    {
      commentId: 'c_gone',
      profileId: OPEN,
      bodySeq: 1,
      source: 'native',
      removedAt: new Date(),
    },
    { commentId: 'c_unconfirmed', profileId: OPEN, source: 'native' },
    {
      commentId: 'c_org',
      profileId: ABOUT,
      tabId: 'org-page:about',
      bodySeq: 1,
      source: 'native',
    },
    {
      commentId: 'c_org_draft',
      profileId: ABOUT,
      tabId: 'org-page:legal',
      bodySeq: 1,
      source: 'native',
    },
    {
      commentId: 'c_org_bad',
      profileId: ABOUT,
      tabId: 'org-page:nowhere',
      bodySeq: 1,
      source: 'native',
    },
    {
      commentId: 'c_lost',
      profileId: new Types.ObjectId(),
      bodySeq: 1,
      source: 'native',
    },
  ]);
  const tabs = fakeModel([
    { profileId: OPEN, tabId: 'tab_a' },
    { profileId: OPEN, tabId: 'tab_old', removedAt: new Date() },
    { profileId: HIDDEN, tabId: 'tab_h' },
  ]);
  const pages = fakeModel([
    { pageId: 'about', published: { revision: 2 } },
    { pageId: 'legal' },
  ]);
  const identities: Record<string, unknown> = {
    user_named: { email: 'named@example.test', emailVerified: true },
    user_anon: { email: 'anon@example.test', emailVerified: true },
    user_admin: {
      email: 'admin@example.test',
      emailVerified: true,
      role: 'admin',
    },
    user_listed: { email: 'listed@example.test', emailVerified: true },
    user_unverified: { email: 'u@example.test', emailVerified: false },
    user_pending: { emailVerified: false },
  };
  const clerk = {
    getIdentity: jest.fn((userId: string) => {
      if (userId === 'user_deleted') {
        return Promise.reject(new UnauthorizedException());
      }
      if (userId === 'user_down') {
        return Promise.reject(new ServiceUnavailableException());
      }
      return Promise.resolve(identities[userId] ?? { emailVerified: false });
    }),
  };
  const adminAccess = {
    isAllowlisted: (email: string | undefined, verified: boolean) =>
      verified && email === 'listed@example.test',
  };
  const targets = new NotificationTargets(
    comments as never,
    profiles as never,
    tabs as never,
    pages as never,
    clerk as never,
    adminAccess as never,
  );
  return { targets, profiles };
}

const reader = (change: Partial<Recipient['viewer']> = {}): Recipient => ({
  userId: 'user_r',
  email: 'r@example.test',
  isAdmin: false,
  viewer: { kind: 'named-member', userId: 'user_r', isAdmin: false, ...change },
});

describe('NotificationTargets (Chunk 14)', () => {
  describe('recipient', () => {
    it('reads the address only when verified, and who the reader is now', async () => {
      const { targets } = build();
      expect(await targets.recipient('user_named')).toEqual({
        userId: 'user_named',
        email: 'named@example.test',
        isAdmin: false,
        viewer: { kind: 'named-member', userId: 'user_named', isAdmin: false },
      });
      expect((await targets.recipient('user_anon'))?.viewer.kind).toBe(
        'anonymous-member',
      );
      const unverified = await targets.recipient('user_unverified');
      expect(unverified).toEqual({
        userId: 'user_unverified',
        isAdmin: false,
        viewer: {
          kind: 'signed-in',
          userId: 'user_unverified',
          isAdmin: false,
        },
      });
      expect((await targets.recipient('user_pending'))?.viewer.kind).toBe(
        'signed-in',
      );
      expect((await targets.recipient('user_admin'))?.isAdmin).toBe(true);
      expect((await targets.recipient('user_listed'))?.isAdmin).toBe(true);
    });

    it('says an account Clerk no longer has is gone, and passes an outage on', async () => {
      const { targets } = build();
      expect(await targets.recipient('user_deleted')).toBeUndefined();
      await expect(targets.recipient('user_down')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('treats a deleted own page as no page', async () => {
      const { targets, profiles } = build();
      profiles.docs.find((d) => d.ownerUserId === 'user_named')!.deletedAt =
        new Date();
      expect((await targets.recipient('user_named'))?.viewer.kind).toBe(
        'signed-in',
      );
    });
  });

  describe('describe', () => {
    const about = (kind: NotificationKind, refs: object) => ({ kind, refs });

    it('sends admin notices only to someone who is an admin now', async () => {
      const { targets } = build();
      const admin = { ...reader(), isAdmin: true };
      for (const kind of [
        'admin-page-submitted',
        'admin-eam-request',
        'admin-report',
      ] as const) {
        expect(await targets.describe(about(kind, {}), admin)).toEqual({
          kind,
          path: '/admin',
        });
        expect(
          await targets.describe(about(kind, {}), reader()),
        ).toBeUndefined();
      }
      expect(
        await targets.describe(about('admin-claim-requested', {}), admin),
      ).toEqual({ kind: 'admin-claim-requested', path: '/admin/claims' });
      expect(
        await targets.describe(about('admin-claim-requested', {}), reader()),
      ).toBeUndefined();
    });

    it('links a comment notice to a page the reader may read in full, never a hidden or removed comment', async () => {
      const { targets } = build();
      expect(
        await targets.describe(
          about('comment-on-page', { commentId: 'c_ok' }),
          reader(),
        ),
      ).toEqual({ kind: 'comment-on-page', path: '/open-page' });
      for (const commentId of [
        'c_hidden',
        'c_removed_mod',
        'c_gone',
        'c_unconfirmed',
        'c_lost',
        'c_nope',
      ]) {
        expect(
          await targets.describe(about('reply', { commentId }), reader()),
        ).toBeUndefined();
      }
      expect(
        await targets.describe(about('reply', {}), reader()),
      ).toBeUndefined();
      // A members-only page: a member reads it; a signed-in reader does not.
      expect(
        await targets.describe(
          about('reply', { commentId: 'c_members' }),
          reader(),
        ),
      ).toEqual({ kind: 'reply', path: '/members-page' });
      expect(
        await targets.describe(
          about('reply', { commentId: 'c_members' }),
          reader({ kind: 'signed-in' }),
        ),
      ).toBeUndefined();
    });

    it('links ORG pages only while they are published', async () => {
      const { targets } = build();
      expect(
        await targets.describe(
          about('reply', { commentId: 'c_org' }),
          reader({ kind: 'signed-in' }),
        ),
      ).toEqual({ kind: 'reply', path: '/about' });
      for (const commentId of ['c_org_draft', 'c_org_bad']) {
        expect(
          await targets.describe(about('reply', { commentId }), reader()),
        ).toBeUndefined();
      }
    });

    it('tells a moderation decision only while it stands, with a link only if readable', async () => {
      const { targets } = build();
      expect(
        await targets.describe(
          about('comment-hidden', { commentId: 'c_hidden' }),
          reader(),
        ),
      ).toEqual({ kind: 'comment-hidden', path: '/open-page' });
      expect(
        await targets.describe(
          about('comment-removed', { commentId: 'c_removed_mod' }),
          reader(),
        ),
      ).toEqual({ kind: 'comment-removed', path: '/open-page' });
      expect(
        await targets.describe(
          about('comment-restored', { commentId: 'c_ok' }),
          reader(),
        ),
      ).toEqual({ kind: 'comment-restored', path: '/open-page' });
      // Undone before the email: not news.
      expect(
        await targets.describe(
          about('comment-hidden', { commentId: 'c_ok' }),
          reader(),
        ),
      ).toBeUndefined();
      expect(
        await targets.describe(
          about('comment-restored', { commentId: 'c_hidden' }),
          reader(),
        ),
      ).toBeUndefined();
      // Removed by its author, or gone: nothing to tell.
      expect(
        await targets.describe(
          about('comment-hidden', { commentId: 'c_gone' }),
          reader(),
        ),
      ).toBeUndefined();
      expect(
        await targets.describe(about('comment-hidden', {}), reader()),
      ).toBeUndefined();
      // On a page the author may no longer read: the community page.
      expect(
        await targets.describe(
          about('comment-restored', { commentId: 'c_members' }),
          reader({ kind: 'signed-in' }),
        ),
      ).toEqual({ kind: 'comment-restored', path: FALLBACK_PATH });
    });

    it('links a claim decision to the page when readable, else the community page', async () => {
      const { targets } = build();
      expect(
        await targets.describe(
          about('claim-approved', { profileId: OPEN }),
          reader(),
        ),
      ).toEqual({ kind: 'claim-approved', path: '/open-page' });
      expect(
        await targets.describe(
          about('claim-rejected', { profileId: HIDDEN }),
          reader(),
        ),
      ).toEqual({ kind: 'claim-rejected', path: FALLBACK_PATH });
      expect(
        await targets.describe(about('claim-rejected', {}), reader()),
      ).toEqual({ kind: 'claim-rejected', path: FALLBACK_PATH });
    });

    it('tells an agreed belief only while it is on the page', async () => {
      const { targets } = build();
      const owner = reader({ userId: 'user_owner' });
      expect(
        await targets.describe(
          about('belief-agreed', { profileId: OPEN, tabId: 'tab_a' }),
          owner,
        ),
      ).toEqual({ kind: 'belief-agreed', path: '/open-page' });
      expect(
        await targets.describe(
          about('belief-agreed', { profileId: OPEN, tabId: 'tab_old' }),
          owner,
        ),
      ).toBeUndefined();
      // A page the reader cannot read any more.
      expect(
        await targets.describe(
          about('belief-agreed', { profileId: HIDDEN, tabId: 'tab_h' }),
          owner,
        ),
      ).toBeUndefined();
    });
  });
});
