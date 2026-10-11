import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type { OrderDocument } from '../orders/schemas/order.schema';
import {
  readSiteEnv,
  TEST_SITE_EMAIL_NOTICE,
  TEST_SITE_SUBJECT_PREFIX,
} from '../config/site-env';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly resend?: Resend;
  private readonly from?: string;
  private readonly hostEmail?: string;
  private readonly publicAppUrl: string;
  private readonly testSite: boolean;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('RESEND_API_KEY');
    this.from = config.get<string>('ORDER_FROM_EMAIL') || undefined;
    this.hostEmail =
      config.get<string>('ORDER_NOTIFICATION_EMAIL') || undefined;
    this.publicAppUrl = config.getOrThrow<string>('PUBLIC_APP_URL');
    this.testSite = readSiteEnv(config) === 'test';
    if (apiKey && this.from && this.hostEmail) {
      this.resend = new Resend(apiKey);
    }
  }

  /** Marks the subject when this backend is the test site. */
  private subject(subject: string): string {
    return this.testSite ? TEST_SITE_SUBJECT_PREFIX + subject : subject;
  }

  /** Joins body lines, opening with the test-site notice on the test site. */
  private body(lines: string[], separator = '\n'): string {
    return (this.testSite ? [TEST_SITE_EMAIL_NOTICE, ...lines] : lines).join(
      separator,
    );
  }

  async sendOrderCreated(
    order: OrderDocument,
  ): Promise<'sent' | 'failed' | 'skipped'> {
    if (!this.resend || !this.from || !this.hostEmail) return 'skipped';

    const itemLines = order.items
      .map(
        (item) =>
          `${item.quantity} × ${item.productName} — ${item.variantLabel}`,
      )
      .join('\n');
    const amount = (order.suggestedTotalCents / 100).toFixed(2);

    try {
      const [member, host] = await Promise.all([
        this.resend.emails.send(
          {
            from: this.from,
            to: order.contact.email,
            subject: this.subject(`Offering request ${order.orderNumber}`),
            text: this.body([
              `Your offering request ${order.orderNumber} is recorded.`,
              '',
              itemLines,
              '',
              `Suggested contribution including shipping: $${amount}`,
              `Donation memo: ${order.donationMemo}`,
              '',
              'Any donation is completed separately through the ORG PayPal or Venmo account and is verified manually.',
              `View your request: ${this.publicAppUrl}/orders/${order.id}`,
            ]),
          },
          { idempotencyKey: `${order.id}-member-created` },
        ),
        this.resend.emails.send(
          {
            from: this.from,
            to: this.hostEmail,
            subject: this.subject(`New offering request ${order.orderNumber}`),
            text: this.body([
              `${order.contact.preferredName} submitted a new offering request.`,
              '',
              itemLines,
              '',
              `Open the admin queue: ${this.publicAppUrl}/admin/orders`,
            ]),
          },
          { idempotencyKey: `${order.id}-host-created` },
        ),
      ]);
      if (member.error || host.error) {
        throw new Error(member.error?.message || host.error?.message);
      }
      return 'sent';
    } catch (error) {
      this.logger.error(
        `Order email failed for ${order.orderNumber}: ${
          error instanceof Error ? error.message : 'Unknown email error'
        }`,
      );
      return 'failed';
    }
  }

  async sendStatusChanged(order: OrderDocument) {
    if (!this.resend || !this.from) return;
    try {
      await this.resend.emails.send(
        {
          from: this.from,
          to: order.contact.email,
          subject: this.subject(
            `${order.orderNumber} is ${order.status.replaceAll('_', ' ')}`,
          ),
          text: this.body(
            [
              `Your offering request is now ${order.status.replaceAll('_', ' ')}.`,
              order.trackingNumber
                ? `Tracking number: ${order.trackingNumber}`
                : '',
              `${this.publicAppUrl}/orders/${order.id}`,
            ].filter(Boolean),
            '\n\n',
          ),
        },
        {
          idempotencyKey: `${order.id}-status-${order.status}-${order.statusHistory.length}`,
        },
      );
    } catch (error) {
      this.logger.error(
        `Status email failed for ${order.orderNumber}: ${
          error instanceof Error ? error.message : 'Unknown email error'
        }`,
      );
    }
  }
}
