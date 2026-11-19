// Review round 4 of Chunk 18: a request sent, withdrawn, dropped by the
// digest as no longer visible, then sent again the same day still reaches
// its recipient, through the real DigestSender and NotificationTargets.
import { harness as connectionsHarness } from '../connections/connections-harness.mocks-spec';
import { page } from '../connections/connections-harness.mocks-spec';
import { fakeConnection } from '../db/transactions.mocks-spec';
import { fakeModel } from '../test-support/fake-model.mocks-spec';
import { DigestSender } from './digest-sender';
import { EmailBudgetStore } from './email-budget.store';
import { MemberNotifier } from './member-notifier.service';
import { harnessConfig } from './notifications-harness.mocks-spec';
import { NotificationPrefsService } from './notification-prefs.service';
import { NotificationTargets } from './notification-targets.service';

const R = 'user_requester';
const T = 'user_target';
const NOW = new Date('2026-11-19T12:00:00Z');

describe('a request withdrawn after the digest dropped it, then sent again', () => {
  it('gets exactly one email, about the live request', async () => {
    const queue = fakeModel([], { unique: [['dedupeKey']], timestamps: true });
    const prefs = new NotificationPrefsService(fakeModel([]) as never);
    const notifier = new MemberNotifier(queue as never, prefs, {
      kick: jest.fn(() => Promise.resolve()),
    } as never);
    const h = connectionsHarness({
      pages: [page(R, 'member-r'), page(T, 'member-t')],
      notifier,
    });
    const targets = new NotificationTargets(
      {} as never,
      h.profiles as never,
      {} as never,
      {} as never,
      {
        getIdentity: () =>
          Promise.resolve({ email: 't@example.test', emailVerified: true }),
      } as never,
      { isAllowlisted: () => false } as never,
      h.connections as never,
      fakeModel([]) as never,
    );
    const config = harnessConfig({ DIGEST_HOUR_UTC: 0 });
    const mail = {
      noticesEnabled: () => true,
      sendNotice: jest.fn<Promise<'sent'>, [{ lines: string[] }]>(() =>
        Promise.resolve('sent'),
      ),
    };
    const digests = new DigestSender(
      queue as never,
      fakeModel([], { unique: [['userId', 'day']], timestamps: true }) as never,
      fakeConnection().connection as never,
      config,
      prefs,
      targets,
      new EmailBudgetStore(fakeModel() as never, config),
      mail as never,
    );
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

    const first = await h.service.send(R, 'member-t', undefined, NOW);
    await h.service.withdraw(R, first.id, NOW);
    await digests.run(later(1));
    expect(queue.docs[0]).toMatchObject({
      status: 'skipped',
      outcome: 'no longer visible',
    });
    const second = await h.service.send(R, 'member-t', undefined, NOW);
    // The member's digest already ran today: it is queued again and goes
    // out with the next one (one digest per member per day).
    await digests.run(later(2));
    expect(mail.sendNotice).not.toHaveBeenCalled();
    await digests.run(later(26 * 60));
    await digests.run(later(27 * 60));
    expect(mail.sendNotice).toHaveBeenCalledTimes(1);
    expect(mail.sendNotice.mock.calls[0][0].lines).toContain(
      '- A member sent you a connection request.',
    );
    expect(queue.docs).toHaveLength(1);
    expect(queue.docs[0]).toMatchObject({
      status: 'sent',
      refs: { connectionId: second.id },
    });
  });
});

describe('a re-send that lands while the digest is describing the old request (review round 5)', () => {
  it('is not lost: the drop of the old one no longer applies, and the next digest sends it', async () => {
    const queue = fakeModel([], { unique: [['dedupeKey']], timestamps: true });
    const prefs = new NotificationPrefsService(fakeModel([]) as never);
    const notifier = new MemberNotifier(queue as never, prefs, {
      kick: jest.fn(() => Promise.resolve()),
    } as never);
    const h = connectionsHarness({
      pages: [page(R, 'member-r'), page(T, 'member-t')],
      notifier,
    });
    const real = new NotificationTargets(
      {} as never,
      h.profiles as never,
      {} as never,
      {} as never,
      {
        getIdentity: () =>
          Promise.resolve({ email: 't@example.test', emailVerified: true }),
      } as never,
      { isAllowlisted: () => false } as never,
      h.connections as never,
      fakeModel([]) as never,
    );
    // Deterministic interleaving: the request is sent again exactly while
    // the digest describes the queued email about the withdrawn one.
    let second: { id: string } | undefined;
    const targets = {
      recipient: (userId: string) => real.recipient(userId),
      describe: async (
        ...args: Parameters<NotificationTargets['describe']>
      ) => {
        const line = await real.describe(...args);
        second ??= await h.service.send(R, 'member-t', undefined, NOW);
        return line;
      },
    };
    const config = harnessConfig({ DIGEST_HOUR_UTC: 0 });
    const mail = {
      noticesEnabled: () => true,
      sendNotice: jest.fn<Promise<'sent'>, [{ lines: string[] }]>(() =>
        Promise.resolve('sent'),
      ),
    };
    const digests = new DigestSender(
      queue as never,
      fakeModel([], { unique: [['userId', 'day']], timestamps: true }) as never,
      fakeConnection().connection as never,
      config,
      prefs,
      targets as never,
      new EmailBudgetStore(fakeModel() as never, config),
      mail as never,
    );
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    const first = await h.service.send(R, 'member-t', undefined, NOW);
    await h.service.withdraw(R, first.id, NOW);
    await digests.run(later(1));
    expect(second).toBeDefined();
    expect(queue.docs[0]).toMatchObject({ status: 'queued' });
    await digests.run(later(26 * 60));
    expect(mail.sendNotice).toHaveBeenCalledTimes(1);
    expect(queue.docs[0]).toMatchObject({
      status: 'sent',
      refs: { connectionId: second!.id },
    });
  });
});
