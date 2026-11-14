// Chunk 14 review round 3 fixes, each written to fail on dbbba14 first.
// Synthetic data only; no email is sent.
import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { composeEmail } from './notification-mail';
import { readNotificationConfig } from './notification-config';
import { NotificationPrefsService } from './notification-prefs.service';
import { NotificationSettingsDto } from './notifications.dto';
import {
  harness,
  harnessConfig,
  NOW,
} from './notifications-harness.mocks-spec';

const HOUR = 60 * 60_000;
const settings = readNotificationConfig(harnessConfig());

describe('Chunk 14 review round 3', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('HIGH 1: a save changes only the booleans it carries', () => {
    const build = () => {
      const model = fakeModel([{ userId: 'user_a', off: ['claims'] }], {
        unique: [['userId']],
      });
      return { model, service: new NotificationPrefsService(model as never) };
    };

    it('ignores the undefined fields a DTO instance carries', async () => {
      const { model, service } = build();
      // As the validation pipe hands it over: every optional field present.
      const change = plainToInstance(NotificationSettingsDto, {
        categories: { votes: false },
      });
      expect(Object.keys(change.categories!).length).toBeGreaterThan(1);
      await service.update('user_a', true, change);
      expect(model.docs[0].off).toEqual(['claims', 'votes']);
      expect(model.docs[0]).not.toHaveProperty('digest');
      expect(model.docs[0]).not.toHaveProperty('immediate');
      expect(model.docs[0]).not.toHaveProperty('adminImmediate');
    });

    it('ignores null and anything else that is not true or false', async () => {
      const { model, service } = build();
      await service.update('user_a', true, {
        categories: { claims: null, replies: 'no', votes: true } as never,
        digest: null as never,
        immediate: 0 as never,
        adminImmediate: undefined,
      });
      expect(model.docs[0].off).toEqual(['claims']);
      expect(model.docs[0]).not.toHaveProperty('digest');
      expect(model.docs[0]).not.toHaveProperty('immediate');
    });
  });

  describe('LOW 3: an immediate replay respects "immediate emails off"', () => {
    it('is withdrawn when the category now goes to the digest', async () => {
      const h = harness();
      const stored = composeEmail({
        items: [{ kind: 'claim-approved', path: '/page' }],
        digest: false,
        userId: 'user_a',
        scope: 'claims',
        signingKey: settings.signingKey,
        publicAppUrl: settings.publicAppUrl,
      });
      const row = h.queued({
        userId: 'user_a',
        kind: 'claim-approved',
        category: 'claims',
        delivery: 'immediate',
        attempts: 1,
        email: stored,
        keyStartedAt: new Date(NOW.getTime() - HOUR),
      });
      await h.prefs.unsubscribe('user_a', 'immediate');
      await h.dispatcher.tick(NOW);
      expect(h.mail.sendNotice).not.toHaveBeenCalled();
      expect(row).toMatchObject({
        status: 'failed',
        outcome: 'withdrawn after unknown send',
      });
    });
  });

  describe('LOW 4: delivered wins over the expiry sweep', () => {
    it('marks an item the sweep failed meanwhile as sent with its digest', async () => {
      const h = harness();
      const item = h.queued({
        userId: 'user_a',
        kind: 'reply',
        category: 'replies',
        delivery: 'digest',
      });
      const other = h.queued({
        userId: 'user_b',
        kind: 'reply',
        category: 'replies',
        delivery: 'digest',
        status: 'failed',
        outcome: 'send refused',
      });
      h.mail.sendNotice.mockImplementationOnce(() => {
        // The sweep runs while the email is out.
        item.status = 'failed';
        item.outcome = 'expired unsent';
        return Promise.resolve('sent');
      });
      expect(await h.digests.forMember('user_a', NOW)).toBe('sent');
      expect(item).toMatchObject({ status: 'sent' });
      // Only what the sweep did is undone, never another failure.
      expect(other.status).toBe('failed');
    });
  });
});
