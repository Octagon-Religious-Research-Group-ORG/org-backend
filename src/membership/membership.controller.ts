import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { getUserSub } from '../auth/auth.helpers';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { WriteThrottle } from '../config/throttle';
import { JoinMembershipDto } from './membership.dto';
import { MembershipService, type RequestOrigin } from './membership.service';

/** The visitor's address (real client IP behind the proxy, see http-app.ts). */
export function originOf(request: Request): RequestOrigin {
  const userAgent = request.headers['user-agent'];
  return {
    ...(request.ip ? { ip: request.ip } : {}),
    ...(typeof userAgent === 'string' ? { userAgent } : {}),
  };
}

/** Public: the terms, the guest entry and the page-address check. */
@Controller('membership')
export class MembershipController {
  constructor(private readonly membership: MembershipService) {}

  @Get('terms')
  terms() {
    return this.membership.terms();
  }

  @Get('slug-availability')
  slugAvailability(@Query('slug') slug: unknown) {
    return this.membership.slugAvailability(
      typeof slug === 'string' ? slug : '',
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
