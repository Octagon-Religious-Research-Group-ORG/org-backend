import {
  BadRequestException,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { verifyWebhook } from '@clerk/backend/webhooks';
import type { Request } from 'express';
import type { Model } from 'mongoose';
import { PageDeletionService } from './page-deletion.service';
import {
  WEBHOOK_EVENT_KEEP_DAYS,
  WebhookEvent,
  type WebhookEventDocument,
} from './schemas/webhook-event.schema';

/** The signing secret's variable: Clerk's own documented name. */
export const WEBHOOK_SECRET_VAR = 'CLERK_WEBHOOK_SIGNING_SECRET';

export const WEBHOOK_OFF = 'Account webhooks are not set up on this server.';
export const WEBHOOK_REFUSED = 'This webhook could not be verified.';

/** The raw body is parsed by this route alone (`configureHttpApp`). */
export const WEBHOOK_PATH = '/api/v1/webhooks/clerk';

/** Svix bodies are small; anything larger is refused before it is read. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;

function isDuplicateKey(error: unknown) {
  return (error as { code?: unknown } | null)?.code === 11000;
}

/**
 * Clerk's `user.deleted` webhook (Chunk 17): hides the member's page exactly
 * as "Delete my page" does, and never deletes anything.
 *
 * - Off without `CLERK_WEBHOOK_SIGNING_SECRET`: 503, and the site runs on.
 * - Verified with Clerk's `verifyWebhook` (MIT, `@clerk/backend`, already a
 *   dependency; Standard Webhooks underneath): the signature over the exact
 *   raw bytes, and a timestamp within five minutes, which is the replay
 *   window. Anything else is 400 with no detail.
 * - Idempotent: Svix redelivers, so the work itself is idempotent, and each
 *   message id is remembered for 30 days (`webhookevents`, TTL) so a
 *   redelivery is answered without repeating it.
 * - Every other event type is acknowledged and ignored.
 */
@Controller('webhooks')
export class ClerkWebhookController {
  private readonly logger = new Logger(ClerkWebhookController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly deletion: PageDeletionService,
    @InjectModel(WebhookEvent.name)
    private readonly eventModel: Model<WebhookEventDocument>,
  ) {}

  @Post('clerk')
  @HttpCode(200)
  async receive(@Req() request: Request) {
    const secret = this.config.get<string>(WEBHOOK_SECRET_VAR);
    if (!secret) throw new ServiceUnavailableException(WEBHOOK_OFF);
    const body: unknown = request.body;
    if (!Buffer.isBuffer(body)) throw new BadRequestException(WEBHOOK_REFUSED);

    const headers = new Headers();
    for (const name of ['svix-id', 'svix-timestamp', 'svix-signature']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    let event: Awaited<ReturnType<typeof verifyWebhook>>;
    try {
      event = await verifyWebhook(
        new globalThis.Request('https://webhook.invalid/clerk', {
          method: 'POST',
          headers,
          body: new Uint8Array(body),
        }),
        { signingSecret: secret },
      );
    } catch {
      throw new BadRequestException(WEBHOOK_REFUSED);
    }
    const id = headers.get('svix-id')!;
    if (await this.eventModel.exists({ _id: id }).exec()) {
      return { received: true, duplicate: true };
    }

    let outcome = 'ignored';
    if (event.type === 'user.deleted') {
      const userId = (event.data as { id?: unknown }).id;
      if (typeof userId === 'string' && userId.length > 0) {
        outcome = await this.deletion.accountDeleted(userId);
      }
    }
    const now = new Date();
    try {
      await this.eventModel.create({
        _id: id,
        type: event.type,
        receivedAt: now,
        expiresAt: new Date(now.getTime() + WEBHOOK_EVENT_KEEP_DAYS * DAY_MS),
      });
    } catch (error) {
      // Two deliveries at once: the work is idempotent, so either is fine.
      if (!isDuplicateKey(error)) throw error;
    }
    this.logger.log(`Clerk webhook ${event.type}: ${outcome}.`);
    return { received: true };
  }
}
