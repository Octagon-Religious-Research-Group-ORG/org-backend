// Review round 6: an email about a connection request is dropped once the
// member it is about (the sender of a new request, the member who accepted)
// no longer has a page, even if the request record somehow still stands.
import { Types } from 'mongoose';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { NotificationTargets } from './notification-targets.service';

const R = 'user_requester';
const T = 'user_target';
const NOW = new Date();

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

const page = (owner: string, over: Record<string, unknown> = {}) => ({
  ownerUserId: owner,
  slug: owner.replace('_', '-'),
  visibility: 'public',
  reviewStatus: 'approved',
  ...over,
});

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

describe('connection emails about a member whose page is gone', () => {
  it('drops a new-request email once its sender deleted their page', async () => {
    const { t, id } = targets(
      [page(R, { deletedAt: NOW }), page(T)],
      'pending',
    );
    await expect(
      ask(t, 'connection-requested', id, T),
    ).resolves.toBeUndefined();
  });

  it('drops an accepted email once the member who accepted is gone or removed', async () => {
    for (const gone of [{ deletedAt: NOW }, { reviewStatus: 'removed' }]) {
      const { t, id } = targets([page(R), page(T, gone)], 'accepted');
      await expect(
        ask(t, 'connection-accepted', id, R),
      ).resolves.toBeUndefined();
    }
    const missing = targets([page(R)], 'accepted');
    await expect(
      ask(missing.t, 'connection-accepted', missing.id, R),
    ).resolves.toBeUndefined();
  });

  it('still sends while that member has their page', async () => {
    const { t, id } = targets(
      [page(R, { reviewStatus: undefined }), page(T)],
      'pending',
    );
    await expect(ask(t, 'connection-requested', id, T)).resolves.toMatchObject({
      kind: 'connection-requested',
    });
  });
});
