import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { getUserSub } from '../auth/auth.helpers';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { SLUG_CHECK_THROTTLE, WriteThrottle } from '../config/throttle';
import { NoStoreWhenSignedInInterceptor } from '../members/no-store.interceptor';
import { AccountThrottleGuard } from './account-throttle.guard';
import { JoinMembershipDto } from './membership.dto';
import { MembershipService, type RequestOrigin } from './membership.service';

/**
 * The visitor's address (real client IP behind the proxy, see http-app.ts).
 * Only what the membership terms disclose: the browser type is not read.
 */
export function originOf(request: Request): RequestOrigin {
  return request.ip ? { ip: request.ip } : {};
}

/** The terms and the guest entry are public; the address check needs a login. */
@Controller('membership')
export class MembershipController {
  constructor(private readonly membership: MembershipService) {}

  @Get('terms')
  terms() {
    return this.membership.terms();
  }

  /**
   * Requires a login with a verified email, and is rationed per visitor and
   * per account, because a "no" reveals that a page exists, unlisted and
   * pending pages included.
   */
  @Get('slug-availability')
  @UseGuards(ClerkAuthGuard, AccountThrottleGuard)
  @UseInterceptors(NoStoreWhenSignedInInterceptor)
  @Throttle({ default: SLUG_CHECK_THROTTLE })
  slugAvailability(
    @Req() request: AuthenticatedRequest,
    @Query('slug') slug: unknown,
  ) {
    return this.membership.slugAvailability(
      typeof slug === 'string' ? slug : '',
      getUserSub(request),
    );
  }

  @Post('guest-entry')
  @HttpCode(204)
  @WriteThrottle()
  async guestEntry(@Req() request: Request) {
    await this.membership.recordGuestEntry(originOf(request));
  }
}

/** Signed-in members: their membership status, and joining. */
@Controller('me/membership')
@UseGuards(ClerkAuthGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class MyMembershipController {
  constructor(private readonly membership: MembershipService) {}

  @Get()
  summary(@Req() request: AuthenticatedRequest) {
    return this.membership.summary(getUserSub(request));
  }

  @Post()
  @WriteThrottle()
  join(@Req() request: AuthenticatedRequest, @Body() body: JoinMembershipDto) {
    return this.membership.join(getUserSub(request), body, originOf(request));
  }
}
