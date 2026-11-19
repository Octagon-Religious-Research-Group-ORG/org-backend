// Review round 8 (LOW-2): a connection email goes only to a reader who
// still has an approved, undeleted page; other email categories are
// unaffected by the reader's page.
import { Types } from 'mongoose';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { NotificationTargets } from './notification-targets.service';

const R = 'user_requester';
const T = 'user_target';
const NOW = new Date();

const page = (owner: string, over: Record<string, unknown> = {}) => ({
  ownerUserId: owner,
  slug: owner.replace('_', '-'),
  visibility: 'public',
  reviewStatus: 'approved',
  ...over,
});

function targets(pages: Array<Record<string, unknown>>, status: string) {
  const id = new Types.ObjectId();
  const t = new NotificationTargets(
    {} as never,
    fakeModel(pages) as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    fakeModel([
      {
        _id: id,
        fromUserId: R,
        toUserId: T,
        status,
        live: true,
        createdAt: NOW,
      },
    ]) as never,
    fakeModel([]) as never,
  );
  return { t, id };
}

const ask = (
  t: NotificationTargets,
  kind: 'connection-requested' | 'connection-accepted',
  id: Types.ObjectId,
  reader: string,
) =>
  t.describe({ kind, refs: { connectionId: id } } as never, {
    userId: reader,
    isAdmin: false,
    viewer: { kind: 'named-member', userId: reader, isAdmin: false },
  });

const GONE: Array<Record<string, unknown>> = [
  { reviewStatus: 'removed' },
  { deletedAt: NOW },
  { reviewStatus: 'pending' },
];

describe('connection emails need the reader to still have a page', () => {
  it('drops a new-request email to a recipient whose page is removed, deleted or waiting', async () => {
    for (const gone of GONE) {
      const { t, id } = targets([page(R), page(T, gone)], 'pending');
      await expect(
        ask(t, 'connection-requested', id, T),
      ).resolves.toBeUndefined();
    }
    const missing = targets([page(R)], 'pending');
    await expect(
      ask(missing.t, 'connection-requested', missing.id, T),
    ).resolves.toBeUndefined();
  });

  it('drops an accepted email to a requester whose page is removed or deleted', async () => {
    for (const gone of GONE) {
      const { t, id } = targets([page(R, gone), page(T)], 'accepted');
      await expect(
        ask(t, 'connection-accepted', id, R),
      ).resolves.toBeUndefined();
    }
  });

  it('still sends while both pages stand', async () => {
    const pending = targets([page(R), page(T)], 'pending');
    await expect(
      ask(pending.t, 'connection-requested', pending.id, T),
    ).resolves.toMatchObject({ kind: 'connection-requested' });
    const accepted = targets([page(R), page(T)], 'accepted');
    await expect(
      ask(accepted.t, 'connection-accepted', accepted.id, R),
    ).resolves.toMatchObject({ kind: 'connection-accepted' });
  });

  it('leaves other categories alone: an admin notice still goes to an admin without a page', async () => {
    const { t } = targets([], 'pending');
    await expect(
      t.describe({ kind: 'admin-report', refs: {} } as never, {
        userId: 'user_admin',
        isAdmin: true,
        viewer: { kind: 'signed-in', userId: 'user_admin', isAdmin: true },
      }),
    ).resolves.toEqual({ kind: 'admin-report', path: '/admin' });
  });
});
