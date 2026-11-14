import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAccessService } from '../auth/admin-access.service';
import { AdminRoleGuard } from '../auth/admin-role.guard';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { getUserSub } from '../auth/auth.helpers';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { WriteThrottle } from '../config/throttle';
import { NoStoreWhenSignedInInterceptor } from '../members/no-store.interceptor';
import { readNotificationConfig } from './notification-config';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationPrefsService } from './notification-prefs.service';
import { NotificationSettingsDto } from './notifications.dto';
import { verifyUnsubscribe } from './unsubscribe-tokens';

export const BAD_UNSUBSCRIBE_LINK =
  'This link is not valid. You can change your email settings after signing in.';

/** A member's own email settings (Chunk 14): signed in, stored nowhere. */
@Controller('me/notification-settings')
@UseGuards(ClerkAuthGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class MyNotificationSettingsController {
  constructor(
    private readonly prefs: NotificationPrefsService,
    private readonly adminAccess: AdminAccessService,
  ) {}

  @Get()
  async mine(@Req() request: AuthenticatedRequest) {
    return this.prefs.view(getUserSub(request), await this.isAdmin(request));
  }

  @Put()
  @WriteThrottle()
  async change(
    @Req() request: AuthenticatedRequest,
    @Body() body: NotificationSettingsDto,
  ) {
    return this.prefs.update(
      getUserSub(request),
      await this.isAdmin(request),
      body,
    );
  }

  private async isAdmin(request: AuthenticatedRequest) {
    try {
      return await this.adminAccess.isAdminForRead(request);
    } catch {
      // Unknown: the admin section is simply not shown or saved this time.
      return false;
    }
  }
}

/**
 * The unsubscribe link (Chunk 14): public, no sign-in. The website page
 * POSTs the token in the body; a mail client's one-click (RFC 8058) POSTs to
 * this address with the token in the query. Turning something off twice is
 * the same answer. A token this server did not sign gets one answer
 * whatever it holds; a signed one gets the same answer whether or not its
 * account still exists.
 */
@Controller('notifications')
export class UnsubscribeController {
  private readonly key: Buffer;

  constructor(
    private readonly prefs: NotificationPrefsService,
    config: ConfigService,
  ) {
    this.key = readNotificationConfig(config).signingKey;
  }

  @Post('unsubscribe')
  @HttpCode(200)
  @WriteThrottle()
  @Header('Cache-Control', 'no-store')
  async unsubscribe(
    @Query('token') queryToken: unknown,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    const raw = typeof body?.token === 'string' ? body.token : queryToken;
    const claim =
      typeof raw === 'string' ? verifyUnsubscribe(this.key, raw) : undefined;
    if (!claim) throw new BadRequestException(BAD_UNSUBSCRIBE_LINK);
    await this.prefs.unsubscribe(claim.userId, claim.scope);
    return { unsubscribed: true, scope: claim.scope };
  }
}

/** Email delivery at a glance, for the admin dashboard's Settings. */
@Controller('admin/notifications')
@UseGuards(ClerkAuthGuard, AdminRoleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class AdminNotificationsController {
  constructor(private readonly dispatcher: NotificationDispatcher) {}

  @Get()
  status() {
    return this.dispatcher.status();
  }
}
