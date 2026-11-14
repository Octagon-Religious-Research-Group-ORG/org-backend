import { BadRequestException } from '@nestjs/common';
import { harnessConfig } from './notifications-harness.mocks-spec';
import { readNotificationConfig } from './notification-config';
import {
  AdminNotificationsController,
  BAD_UNSUBSCRIBE_LINK,
  MyNotificationSettingsController,
  UnsubscribeController,
} from './notifications.controller';
import { signUnsubscribe } from './unsubscribe-tokens';

const request = (sub: string) => ({ auth: { payload: { sub } } }) as never;

describe('notification routes (Chunk 14)', () => {
  it('shows and saves a member’s own settings, admin part for admins only', async () => {
    const prefs = {
      view: jest.fn(() => Promise.resolve({})),
      update: jest.fn(() => Promise.resolve({})),
    };
    const adminAccess = {
      isAdminForRead: jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new Error('clerk down')),
    };
    const controller = new MyNotificationSettingsController(
      prefs as never,
      adminAccess as never,
    );
    await controller.mine(request('user_a'));
    await controller.change(request('user_a'), { digest: false });
    // The role cannot be read: no admin section this time, never an error.
    await controller.mine(request('user_a'));
    expect(prefs.view.mock.calls).toEqual([
      ['user_a', true],
      ['user_a', false],
    ]);
    expect(prefs.update).toHaveBeenCalledWith('user_a', false, {
      digest: false,
    });
  });

  describe('unsubscribe', () => {
    const config = harnessConfig();
    const key = readNotificationConfig(config).signingKey;
    const build = () => {
      const prefs = { unsubscribe: jest.fn(() => Promise.resolve()) };
      return {
        prefs,
        controller: new UnsubscribeController(prefs as never, config),
      };
    };

    it('turns off what the link names, from the body or the one-click query', async () => {
      const { prefs, controller } = build();
      const token = signUnsubscribe(key, 'user_a', 'digest');
      expect(await controller.unsubscribe(undefined, { token })).toEqual({
        unsubscribed: true,
        scope: 'digest',
      });
      // RFC 8058: the form body says only "List-Unsubscribe=One-Click".
      expect(
        await controller.unsubscribe(token, {
          'List-Unsubscribe': 'One-Click',
        }),
      ).toEqual({ unsubscribed: true, scope: 'digest' });
      expect(await controller.unsubscribe(token, undefined)).toEqual({
        unsubscribed: true,
        scope: 'digest',
      });
      expect(prefs.unsubscribe).toHaveBeenCalledTimes(3);
      expect(prefs.unsubscribe).toHaveBeenCalledWith('user_a', 'digest');
    });

    it('answers every token it did not sign the same way, changing nothing', async () => {
      const { prefs, controller } = build();
      const foreign = signUnsubscribe(
        Buffer.from('z'.repeat(32)),
        'user_a',
        'digest',
      );
      for (const [query, body] of [
        [undefined, undefined],
        [undefined, { token: 42 }],
        [['a', 'b'], {}],
        ['nonsense', {}],
        [undefined, { token: foreign }],
      ] as const) {
        await expect(
          controller.unsubscribe(query, body as never),
        ).rejects.toEqual(new BadRequestException(BAD_UNSUBSCRIBE_LINK));
      }
      expect(prefs.unsubscribe).not.toHaveBeenCalled();
    });
  });

  it('gives admins the email status', async () => {
    const dispatcher = { status: jest.fn(() => Promise.resolve({ ok: 1 })) };
    const controller = new AdminNotificationsController(dispatcher as never);
    expect(await controller.status()).toEqual({ ok: 1 });
  });
});
