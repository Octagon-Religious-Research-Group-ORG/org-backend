/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Logger } from '@nestjs/common';
import { Resend } from 'resend';
import {
  TEST_SITE_EMAIL_NOTICE,
  TEST_SITE_SUBJECT_PREFIX,
} from '../config/site-env';
import { NotificationsService } from './notifications.service';

const mockSend = jest.fn();

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
}));

function config(values: Record<string, string | undefined> = {}) {
  return {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn().mockReturnValue('https://org.example.test'),
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orderNumber: 'ORG-20260723-ABC123',
    donationMemo: 'ORG ORDER ORG-20260723-ABC123',
    items: [
      {
        quantity: 2,
        productName: 'Mesh Tool',
        variantLabel: 'Standard',
      },
    ],
    suggestedTotalCents: 3900,
    contact: {
      preferredName: 'Member',
      email: 'member@example.test',
    },
    status: 'preparing',
    statusHistory: [{ status: 'preparing' }],
    ...overrides,
  };
}

function configuredService() {
  return new NotificationsService(
    config({
      RESEND_API_KEY: 'api-key',
      ORDER_FROM_EMAIL: 'orders@example.test',
      ORDER_NOTIFICATION_EMAIL: 'host@example.test',
    }) as never,
  );
}

function testSiteService() {
  return new NotificationsService(
    config({
      RESEND_API_KEY: 'api-key',
      ORDER_FROM_EMAIL: 'orders@example.test',
      ORDER_NOTIFICATION_EMAIL: 'host@example.test',
      SITE_ENV: 'test',
    }) as never,
  );
}

describe('NotificationsService', () => {
  beforeEach(() => {
    mockSend.mockReset();
    jest.mocked(Resend).mockClear();
  });

  it.each([
    ['no API key', {}],
    [
      'no sender',
      {
        RESEND_API_KEY: 'api-key',
        ORDER_NOTIFICATION_EMAIL: 'host@example.test',
      },
    ],
    [
      'no host recipient',
      {
        RESEND_API_KEY: 'api-key',
        ORDER_FROM_EMAIL: 'orders@example.test',
      },
    ],
  ])('skips created email safely with %s', async (_name, values) => {
    const service = new NotificationsService(config(values) as never);

    await expect(service.sendOrderCreated(order() as never)).resolves.toBe(
      'skipped',
    );
  });

  it('skips created email when a partially initialized sender is present', async () => {
    const service = new NotificationsService(config() as never);
    (service as never as { resend: unknown }).resend = {
      emails: { send: mockSend },
    };

    await expect(service.sendOrderCreated(order() as never)).resolves.toBe(
      'skipped',
    );
  });

  it('sends member and host order-created messages', async () => {
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });
    const service = configuredService();

    await expect(service.sendOrderCreated(order() as never)).resolves.toBe(
      'sent',
    );

    expect(Resend).toHaveBeenCalledWith('api-key');
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[0]).toEqual([
      expect.objectContaining({
        from: 'orders@example.test',
        to: 'member@example.test',
        subject: 'Offering request ORG-20260723-ABC123',
        text: expect.stringContaining('2 × Mesh Tool — Standard'),
      }),
      { idempotencyKey: 'order-1-member-created' },
    ]);
    expect(mockSend.mock.calls[1]).toEqual([
      expect.objectContaining({
        to: 'host@example.test',
        text: expect.stringContaining('https://org.example.test/admin/orders'),
      }),
      { idempotencyKey: 'order-1-host-created' },
    ]);
  });

  it.each([
    [
      'member API error',
      [
        { error: { message: 'member failed' } },
        { error: { message: 'host failed' } },
      ],
      'member failed',
    ],
    [
      'host API error',
      [{ error: null }, { error: { message: 'host failed' } }],
      'host failed',
    ],
    ['thrown Error', [new Error('network failed')], 'network failed'],
    ['thrown non-Error', ['network failed'], 'Unknown email error'],
  ])('returns failed and logs a %s', async (_name, outcomes, message) => {
    if (outcomes.length === 1 && outcomes[0] instanceof Error) {
      mockSend.mockRejectedValue(outcomes[0]);
    } else if (outcomes.length === 1) {
      mockSend.mockRejectedValue(outcomes[0]);
    } else {
      for (const outcome of outcomes) mockSend.mockResolvedValueOnce(outcome);
    }
    const service = configuredService();
    const logger = jest
      .spyOn(
        (service as never as { logger: { error: () => void } }).logger,
        'error',
      )
      .mockImplementation();

    await expect(service.sendOrderCreated(order() as never)).resolves.toBe(
      'failed',
    );
    expect(logger).toHaveBeenCalledWith(expect.stringContaining(message));
  });

  it('skips status email without a sender', async () => {
    const service = new NotificationsService(config() as never);

    await expect(
      service.sendStatusChanged(order() as never),
    ).resolves.toBeUndefined();
  });

  it('skips status email when the sender address is missing', async () => {
    const service = new NotificationsService(config() as never);
    (service as never as { resend: unknown }).resend = {
      emails: { send: mockSend },
    };

    await expect(
      service.sendStatusChanged(order() as never),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['with tracking', 'TRACK-1', 'Tracking number: TRACK-1'],
    ['without tracking', undefined, 'https://org.example.test/orders/order-1'],
  ])('sends a status email %s', async (_name, trackingNumber, expectedText) => {
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });
    const service = configuredService();

    await service.sendStatusChanged(
      order({
        status: 'donation_confirmed',
        trackingNumber,
      }) as never,
    );

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'ORG-20260723-ABC123 is donation confirmed',
        text: expect.stringContaining(expectedText),
      }),
      {
        idempotencyKey: 'order-1-status-donation_confirmed-1',
      },
    );
  });

  it.each([
    ['an Error', new Error('network failed'), 'network failed'],
    ['a non-Error', 'network failed', 'Unknown email error'],
  ])('logs a status email failure from %s', async (_name, failure, message) => {
    mockSend.mockRejectedValue(failure);
    const service = configuredService();
    const logger = jest
      .spyOn(
        (service as never as { logger: { error: () => void } }).logger,
        'error',
      )
      .mockImplementation();

    await service.sendStatusChanged(order() as never);

    expect(logger).toHaveBeenCalledWith(expect.stringContaining(message));
  });

  it('marks every email from the test site in subject and body', async () => {
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });
    const service = testSiteService();

    await service.sendOrderCreated(order() as never);
    await service.sendStatusChanged(order() as never);

    expect(mockSend).toHaveBeenCalledTimes(3);
    for (const [message] of mockSend.mock.calls as [
      { subject: string; text: string },
    ][]) {
      expect(message.subject.startsWith(TEST_SITE_SUBJECT_PREFIX)).toBe(true);
      expect(message.text.startsWith(TEST_SITE_EMAIL_NOTICE)).toBe(true);
    }
  });

  it('leaves production emails unmarked', async () => {
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });

    await configuredService().sendStatusChanged(order() as never);

    const [[message]] = mockSend.mock.calls as [
      [{ subject: string; text: string }],
    ];
    expect(message.subject).toBe('ORG-20260723-ABC123 is preparing');
    expect(message.text).not.toContain(TEST_SITE_EMAIL_NOTICE);
  });

  describe('member notifications (Chunk 14)', () => {
    const notice = {
      to: 'member@example.test',
      subject: 'Your ORG activity summary',
      lines: ['Line one', 'Line two'],
      headers: { 'List-Unsubscribe': '<https://org.example.test/u>' },
      idempotencyKey: 'org-digest-1-0',
    };

    it('needs only a key and a sender, and sends with headers and the key', async () => {
      mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });
      const service = new NotificationsService(
        config({
          RESEND_API_KEY: 'api-key',
          NOTIFICATION_FROM_EMAIL: 'ORG <notices@example.test>',
        }) as never,
      );
      expect(service.noticesEnabled()).toBe(true);
      expect(await service.sendNotice(notice)).toBe('sent');
      expect(mockSend).toHaveBeenCalledWith(
        {
          from: 'ORG <notices@example.test>',
          to: 'member@example.test',
          subject: 'Your ORG activity summary',
          text: ['Line one', 'Line two'].join('\n'),
          headers: { 'List-Unsubscribe': '<https://org.example.test/u>' },
        },
        { idempotencyKey: 'org-digest-1-0' },
      );
      // Orders still need their host address.
      expect(await service.sendOrderCreated(order() as never)).toBe('skipped');
    });

    it('falls back to the order sender, shares its client, and marks the test site', async () => {
      mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });
      const service = testSiteService();
      expect(jest.mocked(Resend)).toHaveBeenCalledTimes(1);
      await service.sendNotice(notice);
      const [[message]] = mockSend.mock.calls as [
        [{ from: string; subject: string; text: string }],
      ];
      expect(message.from).toBe('orders@example.test');
      expect(message.subject).toBe(TEST_SITE_SUBJECT_PREFIX + notice.subject);
      expect(message.text.startsWith(TEST_SITE_EMAIL_NOTICE)).toBe(true);
    });

    it('skips without a key or a sender, and reports a failure without the address', async () => {
      const off = new NotificationsService(
        config({ NOTIFICATION_FROM_EMAIL: 'notices@example.test' }) as never,
      );
      expect(off.noticesEnabled()).toBe(false);
      expect(await off.sendNotice(notice)).toBe('skipped');
      expect(
        new NotificationsService(
          config({ RESEND_API_KEY: 'api-key' }) as never,
        ).noticesEnabled(),
      ).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();

      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const service = configuredService();
      mockSend.mockResolvedValueOnce({ data: null, error: { message: 'bad' } });
      expect(await service.sendNotice(notice)).toBe('failed');
      mockSend.mockRejectedValueOnce('odd');
      expect(await service.sendNotice(notice)).toBe('failed');
      expect(logged).toHaveBeenCalledWith(
        'Notification email failed (org-digest-1-0): bad',
      );
      expect(logged).toHaveBeenCalledWith(
        'Notification email failed (org-digest-1-0): Unknown email error',
      );
      expect(JSON.stringify(logged.mock.calls)).not.toContain(
        'member@example.test',
      );
      logged.mockRestore();
    });
  });
});
