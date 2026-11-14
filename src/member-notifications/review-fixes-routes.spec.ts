// Chunk 14 review fixes L5, L6: settings saves. Synthetic data only.
import { ServiceUnavailableException } from '@nestjs/common';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { NotificationPrefsService } from './notification-prefs.service';
import {
  ADMIN_CHECK_UNAVAILABLE,
  MyNotificationSettingsController,
} from './notifications.controller';

const request = (sub: string) => ({ auth: { payload: { sub } } }) as never;

describe('Chunk 14 review fixes: settings', () => {
  it('L5: saves nothing, and answers 503, when it cannot tell whether the member is an admin', async () => {
    const prefs = { view: jest.fn(), update: jest.fn() };
    const controller = new MyNotificationSettingsController(
      prefs as never,
      {
        isAdminForRead: jest.fn().mockRejectedValue(new Error('clerk down')),
      } as never,
    );
    await expect(
      controller.change(request('user_a'), { adminImmediate: false }),
    ).rejects.toEqual(new ServiceUnavailableException(ADMIN_CHECK_UNAVAILABLE));
    expect(prefs.update).not.toHaveBeenCalled();
  });

  it('L6: a save writes only the fields it names, so it never undoes an unsubscribe', async () => {
    const model = fakeModel(
      [
        {
          userId: 'user_a',
          off: [],
          digest: true,
          immediate: true,
          adminImmediate: true,
        },
      ],
      { unique: [['userId']] },
    );
    const service = new NotificationPrefsService(model as never);
    const update = jest.spyOn(model, 'updateOne');
    // An unsubscribe link lands between the page loading and this save.
    await service.unsubscribe('user_a', 'replies');
    await service.unsubscribe('user_a', 'digest');
    update.mockClear();
    await service.update('user_a', false, {
      categories: { votes: false },
      immediate: false,
    });
    expect(await service.get('user_a')).toEqual({
      off: expect.arrayContaining(['replies', 'votes']) as unknown,
      digest: false,
      immediate: false,
      adminImmediate: true,
    });
    // No write sets a field the change did not name.
    for (const call of update.mock.calls) {
      const set = (call[1] as { $set?: Record<string, unknown> }).$set ?? {};
      expect(Object.keys(set).sort()).not.toContain('digest');
      expect(Object.keys(set)).not.toContain('off');
    }
  });
});
