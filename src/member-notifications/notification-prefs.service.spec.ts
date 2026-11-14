import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { DEFAULT_PREFS } from './notification-kinds';
import { NotificationPrefsService } from './notification-prefs.service';

function build(initial: Record<string, unknown>[] = []) {
  const model = fakeModel(initial, { unique: [['userId']] });
  return { model, service: new NotificationPrefsService(model as never) };
}

describe('NotificationPrefsService (Chunk 14)', () => {
  it('gives the defaults to a member who never saved, and no admin section', async () => {
    const { service } = build();
    expect(await service.get('user_a')).toEqual({ ...DEFAULT_PREFS, off: [] });
    const view = await service.view('user_a', false);
    expect(view).toEqual({
      categories: {
        comments: true,
        replies: true,
        suggestions: true,
        votes: true,
        claims: true,
        moderation: true,
      },
      digest: true,
      immediate: true,
    });
    const admin = await service.view('user_a', true);
    expect(admin.admin).toEqual({
      categories: {
        adminPages: true,
        adminEam: true,
        adminReports: true,
        adminClaims: true,
      },
      adminImmediate: true,
    });
  });

  it('reads a stored row, dropping categories it no longer knows', async () => {
    const { service } = build([
      {
        userId: 'user_a',
        off: ['replies', 'gone-category'],
        digest: false,
        immediate: true,
        adminImmediate: false,
      },
      { userId: 'user_b' },
    ]);
    expect(await service.get('user_a')).toEqual({
      off: ['replies'],
      digest: false,
      immediate: true,
      adminImmediate: false,
    });
    // Fields missing from an old row read as on.
    expect(await service.get('user_b')).toEqual({ ...DEFAULT_PREFS, off: [] });
  });

  it('saves only what changed, and ignores admin settings from a non-admin', async () => {
    const { model, service } = build();
    const view = await service.update('user_a', false, {
      categories: { replies: false, adminReports: false, votes: true },
      digest: false,
      adminImmediate: false,
    });
    expect(view.categories.replies).toBe(false);
    expect(view.digest).toBe(false);
    expect(view.immediate).toBe(true);
    expect(model.docs).toHaveLength(1);
    expect(model.docs[0]).toMatchObject({
      userId: 'user_a',
      off: ['replies'],
      digest: false,
    });
    // Fields the change did not name are not written (review L6).
    expect(model.docs[0]).not.toHaveProperty('adminImmediate');
    expect(await service.get('user_a')).toMatchObject({
      immediate: true,
      adminImmediate: true,
    });
    // An admin may change their own section; turning a category back on.
    const admin = await service.update('user_a', true, {
      categories: { adminReports: false, replies: true },
      adminImmediate: false,
      immediate: false,
    });
    expect(admin.admin).toEqual({
      categories: {
        adminPages: true,
        adminEam: true,
        adminReports: false,
        adminClaims: true,
      },
      adminImmediate: false,
    });
    expect(model.docs[0]).toMatchObject({
      off: ['adminReports'],
      immediate: false,
      adminImmediate: false,
    });
    // Turning several off at once.
    await service.update('user_a', true, {
      categories: { comments: false, adminEam: false },
    });
    expect((await service.get('user_a')).off.sort()).toEqual([
      'adminEam',
      'adminReports',
      'comments',
    ]);
    // An empty change keeps everything.
    await service.update('user_a', true, {});
    expect(model.docs[0]).toMatchObject({ digest: false });
  });

  it('turns one category or one channel off from a link, twice the same', async () => {
    const { model, service } = build();
    await service.unsubscribe('user_a', 'replies');
    await service.unsubscribe('user_a', 'replies');
    await service.unsubscribe('user_a', 'digest');
    await service.unsubscribe('user_a', 'immediate');
    await service.unsubscribe('user_a', 'adminImmediate');
    expect(model.docs).toHaveLength(1);
    expect(await service.get('user_a')).toEqual({
      off: ['replies'],
      digest: false,
      immediate: false,
      adminImmediate: false,
    });
  });

  it('retries once when two first saves race, and passes other failures on', async () => {
    let fail: unknown;
    const model = fakeModel([{ userId: 'user_a' }], {
      beforeWrite: () => {
        if (fail) {
          const error = fail;
          fail = undefined;
          throw error as Error;
        }
      },
    });
    const service = new NotificationPrefsService(model as never);
    fail = Object.assign(new Error('dup'), { code: 11000 });
    await service.unsubscribe('user_a', 'votes');
    fail = Object.assign(new Error('dup'), { code: 11000 });
    await service.update('user_a', false, { digest: false });
    expect(await service.get('user_a')).toMatchObject({
      off: ['votes'],
      digest: false,
    });
    fail = new Error('down');
    await expect(service.unsubscribe('user_a', 'votes')).rejects.toThrow(
      'down',
    );
    fail = new Error('down');
    await expect(
      service.update('user_a', false, { digest: true }),
    ).rejects.toThrow('down');
  });
});
