import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { fakeConnection } from '../db/transactions.mocks-spec';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import {
  ALREADY_PURGED,
  CONFIRM_MISMATCH,
  DELETION_DISCLOSURE,
  NOT_DELETED,
  OWN_PAGE_RESTORE,
  PAGE_ALREADY_DELETED,
  PAGE_BUSY,
  PAGE_CHANGED,
  PAGE_NOT_FOUND,
  purgeAfterOf,
  UNDO_EXPIRED,
  UNDO_NOT_YOURS,
  undoUntilOf,
  WEBHOOK_ACTOR,
} from './member-data.constants';
import { writeGateId } from './schemas/user-write-gate.schema';
import { PageDeletionService } from './page-deletion.service';
import {
  accountDeletedKey,
  parseAccountDeleted,
} from '../anchoring/account-deletion-record';

const OWNER = 'user_owner';
const ADMIN = 'user_admin';
const NOW = new Date('2026-11-14T12:00:00Z');
const LATER = new Date('2026-11-20T12:00:00Z');

function harness(pages: Array<Record<string, unknown>> = [page()]) {
  const profiles = fakeModel(pages);
  const queue = fakeModel([
    { status: 'queued', refs: { profileId: pages[0]?._id }, userId: 'user_r' },
    { status: 'queued', refs: {}, userId: OWNER },
    { status: 'queued', refs: {}, userId: 'user_r', actorUserId: OWNER },
    { status: 'sent', refs: { profileId: pages[0]?._id }, userId: 'user_r' },
  ]);
  const log = { record: jest.fn(() => Promise.resolve({})) };
  const accounts = fakeModel([], { unique: [['userId']] });
  const comments = fakeModel([
    { commentId: 'c-2', authorUserId: OWNER },
    { commentId: 'c-1', authorUserId: OWNER, kind: 'suggestion' },
    { commentId: 'c-x', authorUserId: 'user_r' },
  ]);
  const commentVersions = fakeModel([], { unique: [['commentId', 'seq']] });
  const { connection, session } = fakeConnection();
  const gates = fakeModel([]);
  const service = new PageDeletionService(
    connection as never,
    profiles as never,
    queue as never,
    log as never,
    accounts as never,
    comments as never,
    commentVersions as never,
    gates as never,
  );
  return {
    service,
    gates,
    profiles,
    queue,
    log,
    session,
    accounts,
    comments,
    commentVersions,
  };
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    slug: 'quiet-fern',
    displayName: 'Quiet Fern',
    ownerUserId: OWNER,
    reviewStatus: 'approved',
    visibility: 'public',
    ...overrides,
  };
}

describe('PageDeletionService: "Delete my page"', () => {
  it('takes the page off the site and keeps it five years, logged in one transaction', async () => {
    const h = harness();
    const result = await h.service.deleteOwn(OWNER, '  Quiet-Fern ', NOW);
    expect(result).toEqual({
      deleted: true,
      undoUntil: undoUntilOf(NOW).toISOString(),
      purgeAfter: purgeAfterOf(NOW).toISOString(),
    });
    expect(h.profiles.docs[0]).toMatchObject({
      deletedAt: NOW,
      // Untouched: an undo brings back the page exactly as it stood.
      reviewStatus: 'approved',
      deletion: {
        at: NOW,
        source: 'member',
        undoUntil: undoUntilOf(NOW),
        purgeAfter: purgeAfterOf(NOW),
      },
    });
    expect(purgeAfterOf(NOW).toISOString()).toBe('2031-11-14T12:00:00.000Z');
    expect(undoUntilOf(NOW).toISOString()).toBe('2026-12-14T12:00:00.000Z');
    expect(h.session.committed).toBe(1);
    expect(h.log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: OWNER,
        action: 'page.deleted',
        targetType: 'member-page',
        targetId: String(h.profiles.docs[0]._id),
        details: { slug: 'quiet-fern', ownerUserId: OWNER },
      }),
      h.session,
    );
  });

  it('withdraws the emails waiting about the page, and only those', async () => {
    const h = harness();
    await h.service.deleteOwn(OWNER, 'quiet-fern', NOW);
    expect(h.queue.docs.map((row) => row.status)).toEqual([
      'skipped',
      'queued',
      'queued',
      'sent',
    ]);
  });

  it('keeps the deletion when withdrawing the emails fails', async () => {
    const h = harness();
    h.queue.updateMany = () => {
      throw new Error('queue down');
    };
    await expect(
      h.service.deleteOwn(OWNER, 'quiet-fern', NOW),
    ).resolves.toMatchObject({ deleted: true });
    h.queue.updateMany = () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error on purpose
      throw 'plain';
    };
    delete h.profiles.docs[0].deletedAt;
    await expect(
      h.service.deleteOwn(OWNER, 'quiet-fern', NOW),
    ).resolves.toMatchObject({ deleted: true });
  });

  it('refuses a mistyped address, and changes nothing', async () => {
    const h = harness();
    await expect(h.service.deleteOwn(OWNER, 'quiet-fen', NOW)).rejects.toThrow(
      new BadRequestException(CONFIRM_MISMATCH),
    );
    expect(h.profiles.docs[0].deletedAt).toBeUndefined();
    expect(h.log.record).not.toHaveBeenCalled();
  });

  it('refuses without a page, while joining, and twice', async () => {
    await expect(
      harness([]).service.deleteOwn(OWNER, 'quiet-fern', NOW),
    ).rejects.toThrow(new NotFoundException(PAGE_NOT_FOUND));
    await expect(
      harness([page({ reviewStatus: 'claiming' })]).service.deleteOwn(
        OWNER,
        'quiet-fern',
        NOW,
      ),
    ).rejects.toThrow(new ConflictException(PAGE_BUSY));
    const h = harness();
    await h.service.deleteOwn(OWNER, 'quiet-fern', NOW);
    await expect(h.service.deleteOwn(OWNER, 'quiet-fern', NOW)).rejects.toThrow(
      new ConflictException(PAGE_ALREADY_DELETED),
    );
  });

  it('only ever touches the signed-in account’s own page', async () => {
    const other = page({ slug: 'other-page', ownerUserId: 'user_other' });
    const h = harness([other, page()]);
    await expect(
      h.service.deleteOwn(OWNER, 'other-page', NOW),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.profiles.docs[0].deletedAt).toBeUndefined();
  });

  it('is a 409 when the page moved between the read and the write', async () => {
    const h = harness();
    h.profiles.updateOne = () => ({
      exec: () => Promise.resolve({ matchedCount: 0, modifiedCount: 0 }),
    });
    await expect(h.service.deleteOwn(OWNER, 'quiet-fern', NOW)).rejects.toThrow(
      new ConflictException(PAGE_CHANGED),
    );
  });
});

describe('PageDeletionService: status', () => {
  it('reports no page, a page, and a deleted page with its undo window', async () => {
    expect(await harness([]).service.status(OWNER)).toEqual({
      page: null,
      disclosure: DELETION_DISCLOSURE,
    });
    expect(
      await harness([page({ reviewStatus: 'claiming' })]).service.status(OWNER),
    ).toMatchObject({ page: null });
    const h = harness([page({ ownerUserId: undefined }), page()]);
    expect(await h.service.status(OWNER)).toEqual({
      page: { slug: 'quiet-fern', displayName: 'Quiet Fern', deleted: false },
      disclosure: DELETION_DISCLOSURE,
    });
    await h.service.deleteOwn(OWNER, 'quiet-fern', NOW);
    expect(await h.service.status(OWNER, LATER)).toEqual({
      page: {
        slug: 'quiet-fern',
        displayName: 'Quiet Fern',
        deleted: true,
        deletedAt: NOW.toISOString(),
        source: 'member',
        undoUntil: undoUntilOf(NOW).toISOString(),
        purgeAfter: purgeAfterOf(NOW).toISOString(),
      },
      disclosure: DELETION_DISCLOSURE,
    });
    const afterWindow = new Date(undoUntilOf(NOW).getTime() + 1);
    expect(
      (await h.service.status(OWNER, afterWindow)).page,
    ).not.toHaveProperty('undoUntil');
  });

  it('offers no undo for an account deletion or a purged page', async () => {
    const at = NOW;
    const base = { deletedAt: at, purgeAfter: purgeAfterOf(at) };
    const status = async (deletion: Record<string, unknown>) =>
      (
        await harness([
          page({ deletedAt: at, deletion: { at, ...base, ...deletion } }),
        ]).service.status(OWNER, LATER)
      ).page;
    expect(await status({ source: 'account-deleted' })).not.toHaveProperty(
      'undoUntil',
    );
    expect(
      await status({
        source: 'member',
        undoUntil: undoUntilOf(at),
        purgedAt: LATER,
      }),
    ).not.toHaveProperty('undoUntil');
    expect(await status({ source: 'member' })).not.toHaveProperty('undoUntil');
    // deletedAt without a deletion record (never written by this code).
    expect(
      (await harness([page({ deletedAt: at })]).service.status(OWNER)).page,
    ).toMatchObject({ deleted: false });
  });
});

describe('PageDeletionService: undo', () => {
  it('brings the page back inside the window, logged', async () => {
    const h = harness([page({ reviewStatus: 'removed' })]);
    await h.service.deleteOwn(OWNER, 'quiet-fern', NOW);
    await expect(h.service.undoOwn(OWNER, LATER)).resolves.toEqual({
      deleted: false,
    });
    expect(h.profiles.docs[0]).not.toHaveProperty('deletedAt');
    expect(h.profiles.docs[0]).not.toHaveProperty('deletion');
    // An admin's earlier removal stands.
    expect(h.profiles.docs[0].reviewStatus).toBe('removed');
    expect(h.log.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actorUserId: OWNER,
        action: 'page.deletion-undone',
      }),
      h.session,
    );
  });

  it('refuses after the window, for an account deletion, after the purge, and when not deleted', async () => {
    const h = harness();
    await expect(h.service.undoOwn(OWNER, NOW)).rejects.toThrow(
      new ConflictException(NOT_DELETED),
    );
    await expect(harness([]).service.undoOwn(OWNER, NOW)).rejects.toThrow(
      new NotFoundException(PAGE_NOT_FOUND),
    );
    await h.service.deleteOwn(OWNER, 'quiet-fern', NOW);
    await expect(h.service.undoOwn(OWNER, undoUntilOf(NOW))).rejects.toThrow(
      new ForbiddenException(UNDO_EXPIRED),
    );
    const at = NOW;
    const deleted = (deletion: Record<string, unknown>) =>
      harness([
        page({
          deletedAt: at,
          deletion: { at, purgeAfter: purgeAfterOf(at), ...deletion },
        }),
      ]).service.undoOwn(OWNER, LATER);
    await expect(deleted({ source: 'account-deleted' })).rejects.toThrow(
      new ForbiddenException(UNDO_NOT_YOURS),
    );
    await expect(
      deleted({ source: 'member', undoUntil: undoUntilOf(at), purgedAt: at }),
    ).rejects.toThrow(new ForbiddenException(ALREADY_PURGED));
    await expect(deleted({ source: 'member' })).rejects.toThrow(
      new ForbiddenException(UNDO_EXPIRED),
    );
  });
});

describe('PageDeletionService: account deleted (webhook)', () => {
  it('hides the page like "Delete my page", without an undo, logged as the webhook', async () => {
    const h = harness();
    await expect(h.service.accountDeleted(OWNER, NOW)).resolves.toBe('deleted');
    expect(h.profiles.docs[0]).toMatchObject({
      deletedAt: NOW,
      deletion: {
        at: NOW,
        source: 'account-deleted',
        purgeAfter: purgeAfterOf(NOW),
      },
    });
    expect(h.profiles.docs[0].deletion).not.toHaveProperty('undoUntil');
    expect(h.log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: WEBHOOK_ACTOR,
        action: 'page.account-deleted',
      }),
      h.session,
    );
    // Emails about the page AND to or from the gone account are withdrawn.
    expect(h.queue.docs.map((row) => row.status)).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'sent',
    ]);
  });

  it('is idempotent: a redelivery changes nothing', async () => {
    const h = harness();
    await h.service.accountDeleted(OWNER, NOW);
    await expect(h.service.accountDeleted(OWNER, LATER)).resolves.toBe(
      'already',
    );
    expect(h.profiles.docs[0].deletedAt).toEqual(NOW);
    expect(h.log.record).toHaveBeenCalledTimes(1);
  });

  it('keeps the five-year clock of an earlier deletion, and drops the member’s undo', async () => {
    const h = harness();
    await h.service.deleteOwn(OWNER, 'quiet-fern', NOW);
    await expect(h.service.accountDeleted(OWNER, LATER)).resolves.toBe(
      'deleted',
    );
    expect(h.profiles.docs[0]).toMatchObject({
      deletedAt: NOW,
      deletion: {
        at: NOW,
        source: 'account-deleted',
        purgeAfter: purgeAfterOf(NOW),
      },
    });
    expect(h.profiles.docs[0].deletion).not.toHaveProperty('undoUntil');
    await expect(h.service.undoOwn(OWNER, LATER)).rejects.toThrow(
      new ForbiddenException(UNDO_NOT_YOURS),
    );
  });

  it('keeps a purge mark, and dates a bare deletedAt from itself', async () => {
    const at = NOW;
    const purged = harness([
      page({
        deletedAt: at,
        deletion: {
          at,
          source: 'member',
          purgeAfter: purgeAfterOf(at),
          purgedAt: LATER,
        },
      }),
    ]);
    await purged.service.accountDeleted(OWNER, LATER);
    expect(purged.profiles.docs[0].deletion).toMatchObject({
      source: 'account-deleted',
      purgedAt: LATER,
    });
    const bare = harness([page({ deletedAt: at })]);
    await bare.service.accountDeleted(OWNER, LATER);
    expect(bare.profiles.docs[0].deletion).toMatchObject({
      at,
      purgeAfter: purgeAfterOf(at),
    });
  });

  it('records an account without a page, so it is purged later (review #6)', async () => {
    const h = harness([]);
    await expect(h.service.accountDeleted(OWNER, NOW)).resolves.toBe('no-page');
    expect(h.log.record).not.toHaveBeenCalled();
    expect(h.accounts.docs).toEqual([
      expect.objectContaining({
        userId: OWNER,
        at: NOW,
        purgeAfter: purgeAfterOf(NOW),
      }),
    ]);
    expect(h.accounts.docs[0]).not.toHaveProperty('profileId');
  });

  it('records the account once, with its first time and its page (review #6)', async () => {
    const h = harness();
    await h.service.accountDeleted(OWNER, NOW);
    await h.service.accountDeleted(OWNER, LATER);
    expect(h.accounts.docs).toHaveLength(1);
    expect(h.accounts.docs[0]).toMatchObject({
      at: NOW,
      purgeAfter: purgeAfterOf(NOW),
      profileId: h.profiles.docs[0]._id,
    });
  });

  it('starts the account clock at the account deletion, the page keeping its own', async () => {
    const h = harness();
    await h.service.deleteOwn(OWNER, 'quiet-fern', NOW);
    await h.service.accountDeleted(OWNER, LATER);
    expect(h.accounts.docs[0]).toMatchObject({
      at: LATER,
      purgeAfter: purgeAfterOf(LATER),
    });
    expect(h.profiles.docs[0]).toMatchObject({
      deletion: { purgeAfter: purgeAfterOf(NOW) },
    });
  });
});

describe('PageDeletionService: the server clock', () => {
  it('uses the current time when none is given', async () => {
    const h = harness();
    await h.service.deleteOwn(OWNER, 'quiet-fern');
    expect(h.profiles.docs[0].deletedAt).toBeInstanceOf(Date);
    await expect(h.service.undoOwn(OWNER)).resolves.toEqual({ deleted: false });
    await expect(h.service.accountDeleted(OWNER)).resolves.toBe('deleted');
    (h.profiles.docs[0].deletion as Record<string, unknown>).purgeAfter =
      new Date(Date.now() + 60_000);
    await expect(
      h.service.adminRestore(ADMIN, 'quiet-fern', 'Back.'),
    ).resolves.toEqual({ restored: true, ownerAccountGone: true });
  });

  it('restores an imported page no one owns, logging no owner', async () => {
    const h = harness([
      page({
        ownerUserId: undefined,
        deletedAt: NOW,
        deletion: { at: NOW, source: 'member', purgeAfter: purgeAfterOf(NOW) },
      }),
    ]);
    await h.service.adminRestore(ADMIN, 'quiet-fern', 'Back.', LATER);
    expect(h.log.record).toHaveBeenCalledWith(
      expect.objectContaining({ details: { slug: 'quiet-fern' } }),
      h.session,
    );
  });
});

describe('PageDeletionService: round 2 (#5, #6)', () => {
  const started = (source: string) =>
    harness([
      page({
        deletedAt: NOW,
        deletion: {
          at: NOW,
          source,
          undoUntil: undoUntilOf(NOW),
          purgeAfter: purgeAfterOf(NOW),
          purgeStartedAt: LATER,
        },
      }),
    ]);

  it('refuses undo and restore once the purge has started (#5)', async () => {
    await expect(
      started('member').service.undoOwn(OWNER, LATER),
    ).rejects.toThrow(new ForbiddenException(ALREADY_PURGED));
    await expect(
      started('member').service.adminRestore(
        ADMIN,
        'quiet-fern',
        'Why.',
        LATER,
      ),
    ).rejects.toThrow(new ConflictException(ALREADY_PURGED));
  });

  it('refuses at the write too, when the purge starts meanwhile (#5)', async () => {
    const h = harness();
    await h.service.deleteOwn(OWNER, 'quiet-fern', NOW);
    const updateOne = h.profiles.updateOne;
    // The read saw no mark; the purge marks the page before the write lands.
    h.profiles.updateOne = (...args: Parameters<typeof updateOne>) => {
      (h.profiles.docs[0].deletion as Record<string, unknown>).purgeStartedAt =
        LATER;
      return updateOne(...args);
    };
    await expect(h.service.undoOwn(OWNER, LATER)).rejects.toThrow(
      new ConflictException(PAGE_CHANGED),
    );
  });

  it('keeps the purge mark when the account deletion arrives (#5)', async () => {
    const h = started('member');
    await h.service.accountDeleted(OWNER, LATER);
    expect(h.profiles.docs[0].deletion).toMatchObject({
      source: 'account-deleted',
      purgeStartedAt: LATER,
    });
  });

  it('leaves the page clock alone once the account is recorded (L-2)', async () => {
    const h = harness();
    await h.service.accountDeleted(OWNER, NOW);
    await h.service.adminRestore(ADMIN, 'quiet-fern', 'Asked.', LATER);
    // Svix redelivers years later: the restored page gets no new clock.
    await expect(
      h.service.accountDeleted(OWNER, new Date('2030-01-01T00:00:00Z')),
    ).resolves.toBe('already');
    expect(h.profiles.docs[0]).not.toHaveProperty('deletedAt');
  });

  it('says the owner account is gone, in the list and on restore (#6)', async () => {
    const h = harness();
    await h.service.accountDeleted(OWNER, NOW);
    expect((await h.service.list(1)).pages[0].ownerAccountGone).toBe(true);
    await expect(
      h.service.adminRestore(ADMIN, 'quiet-fern', 'Asked.', LATER),
    ).resolves.toEqual({ restored: true, ownerAccountGone: true });
  });
});

describe('PageDeletionService: admins', () => {
  async function deletedHarness() {
    const h = harness([
      page(),
      page({ slug: 'admin-page', ownerUserId: ADMIN, displayName: 'Admin' }),
    ]);
    await h.service.deleteOwn(OWNER, 'quiet-fern', NOW);
    await h.service.deleteOwn(ADMIN, 'admin-page', NOW);
    return h;
  }

  it('lists deleted pages, the next due first, with no Clerk id in them', async () => {
    const h = await deletedHarness();
    h.profiles.docs[1].deletion = {
      ...(h.profiles.docs[1].deletion as Record<string, unknown>),
      purgeAfter: new Date('2030-01-01T00:00:00Z'),
      purgedAt: LATER,
    };
    const list = await h.service.list(1);
    expect(list.hasMore).toBe(false);
    expect(list.pages).toEqual([
      {
        slug: 'admin-page',
        displayName: 'Admin',
        source: 'member',
        deletedAt: NOW.toISOString(),
        undoUntil: undoUntilOf(NOW).toISOString(),
        purgeAfter: '2030-01-01T00:00:00.000Z',
        ownerAccountGone: false,
        purgedAt: LATER.toISOString(),
      },
      expect.objectContaining({ slug: 'quiet-fern' }),
    ]);
    // Review #9: no Clerk id leaves for the admin screen.
    expect(JSON.stringify(list)).not.toMatch(/user_/);
    const unowned = harness([
      page({
        ownerUserId: undefined,
        deletedAt: NOW,
        deletion: {
          at: NOW,
          source: 'account-deleted',
          purgeAfter: purgeAfterOf(NOW),
        },
      }),
    ]);
    expect((await unowned.service.list(1)).pages[0]).not.toHaveProperty(
      'ownerUserId',
    );
  });

  it('pages the list', async () => {
    const pages = Array.from({ length: 31 }, (_, i) =>
      page({
        slug: `page-${i}`,
        ownerUserId: `user_${i}`,
        deletedAt: NOW,
        deletion: { at: NOW, source: 'member', purgeAfter: purgeAfterOf(NOW) },
      }),
    );
    const h = harness(pages);
    expect(await h.service.list(1)).toMatchObject({ hasMore: true });
    expect((await h.service.list(2)).pages).toHaveLength(1);
  });

  it('restores a deleted page, logged with the reason', async () => {
    const h = await deletedHarness();
    await expect(
      h.service.adminRestore(
        ADMIN,
        ' Quiet-Fern ',
        'Asked by the member.',
        LATER,
      ),
    ).resolves.toEqual({ restored: true, ownerAccountGone: false });
    expect(h.profiles.docs[0]).not.toHaveProperty('deletedAt');
    expect(h.log.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actorUserId: ADMIN,
        action: 'page.deletion-restored',
        reason: 'Asked by the member.',
      }),
      h.session,
    );
  });

  it('refuses their own page, a page not deleted, a bad address, an empty reason, and a page due or purged', async () => {
    const h = await deletedHarness();
    await expect(
      h.service.adminRestore(ADMIN, 'admin-page', 'Mine.', LATER),
    ).rejects.toThrow(new ForbiddenException(OWN_PAGE_RESTORE));
    await expect(
      h.service.adminRestore(ADMIN, 'nobody-here', 'Why.', LATER),
    ).rejects.toThrow(new NotFoundException(NOT_DELETED));
    await expect(
      h.service.adminRestore(ADMIN, 'Not A Slug!', 'Why.', LATER),
    ).rejects.toThrow(new NotFoundException(NOT_DELETED));
    await expect(
      h.service.adminRestore(ADMIN, 'quiet-fern', '   ', LATER),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      h.service.adminRestore(
        ADMIN,
        'quiet-fern',
        'Too late.',
        purgeAfterOf(NOW),
      ),
    ).rejects.toThrow(new ConflictException(ALREADY_PURGED));
    (h.profiles.docs[0].deletion as Record<string, unknown>).purgedAt = LATER;
    await expect(
      h.service.adminRestore(ADMIN, 'quiet-fern', 'Too late.', LATER),
    ).rejects.toThrow(new ConflictException(ALREADY_PURGED));
    // A deletion record left on a page someone already brought back.
    const stray = harness([
      page({
        deletion: { at: NOW, source: 'member', purgeAfter: purgeAfterOf(NOW) },
      }),
    ]);
    await expect(
      stray.service.adminRestore(ADMIN, 'quiet-fern', 'Why.', LATER),
    ).rejects.toThrow(new NotFoundException(NOT_DELETED));
  });
});

describe('PageDeletionService: the anchored account-deletion record (round 4, #2)', () => {
  it('writes it once, in the webhook transaction, listing the authored comment ids only', async () => {
    const h = harness();
    const create = jest.spyOn(h.commentVersions, 'create');
    await h.service.accountDeleted(OWNER, NOW);
    const account = h.accounts.docs[0];
    const rows = h.commentVersions.docs;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      commentId: accountDeletedKey(String(account._id)),
      seq: 1,
      createdAt: NOW,
    });
    expect(parseAccountDeleted(rows[0].text as string)).toMatchObject({
      accountId: String(account._id),
      deletedAt: NOW.toISOString(),
      commentIds: ['c-1', 'c-2'],
    });
    // Ids only: never the Clerk id.
    expect(JSON.stringify(rows)).not.toContain(OWNER);
    expect(create).toHaveBeenCalledWith(expect.any(Array), {
      session: h.session,
      ordered: true,
    });
    // A redelivery, later: the first record stands alone.
    await h.service.accountDeleted(OWNER, LATER);
    expect(h.commentVersions.docs).toHaveLength(1);
  });

  it('writes it for an account with no page too', async () => {
    const h = harness([]);
    await expect(h.service.accountDeleted(OWNER, NOW)).resolves.toBe('no-page');
    expect(h.commentVersions.docs).toHaveLength(1);
  });

  it('fails the webhook when the record cannot be written', async () => {
    const h = harness();
    h.commentVersions.create = () => Promise.reject(new Error('disk full'));
    await expect(h.service.accountDeleted(OWNER, NOW)).rejects.toThrow(
      'disk full',
    );
    expect(h.session.aborted).toBe(1);
  });
});

describe('PageDeletionService: the write gate (Chunk 17 round 9, F2)', () => {
  it('writes the gate inside the webhook transaction, before it reads the comments', async () => {
    const h = harness();
    const order: string[] = [];
    const update = h.gates.updateOne;
    h.gates.updateOne = (...args: Parameters<typeof update>) => {
      order.push('gate');
      return update(...args);
    };
    const find = h.comments.find;
    h.comments.find = (...args: Parameters<typeof find>) => {
      order.push('comments');
      return find(...args);
    };
    await h.service.accountDeleted(OWNER, NOW);
    expect(order).toEqual(['gate', 'comments']);
    expect(h.gates.docs).toEqual([
      expect.objectContaining({ _id: writeGateId(OWNER), at: NOW }),
    ]);
    expect(JSON.stringify(h.gates.docs)).not.toContain(OWNER);
  });
});
