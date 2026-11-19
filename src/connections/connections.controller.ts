import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AdminRoleGuard } from '../auth/admin-role.guard';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { getUserSub } from '../auth/auth.helpers';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { WriteThrottle } from '../config/throttle';
import { AccountNotDeletedGuard } from '../members/account-not-deleted.guard';
import { MemberWriteThrottleGuard } from '../members/member-write-throttle.guard';
import { NoStoreWhenSignedInInterceptor } from '../members/no-store.interceptor';
import { ConnectionTermsService } from './connection-terms.service';
import {
  BlockDto,
  ConnectionSettingsDto,
  ConnectionTermsDto,
  SendConnectionDto,
} from './connections.dto';
import { ConnectionsService } from './connections.service';
import { ConnectionViews } from './connection-views.service';

/** The feature's name, for every page that mentions it. No sign-in needed. */
@Controller('connections')
export class ConnectionTermsController {
  constructor(private readonly terms: ConnectionTermsService) {}

  @Get('terms')
  get() {
    return this.terms.terms();
  }
}

/**
 * The member's own requests and connections (Chunk 18). Who is asking comes
 * only from the verified token; no route takes an account id.
 */
@Controller('me/connections')
@UseGuards(ClerkAuthGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class MyConnectionsController {
  constructor(private readonly connections: ConnectionViews) {}

  @Get()
  overview(@Req() request: AuthenticatedRequest) {
    return this.connections.overview(getUserSub(request));
  }

  /** Where the member stands with a page's owner: the profile button. */
  @Get('with/:slug')
  relation(@Req() request: AuthenticatedRequest, @Param('slug') slug: string) {
    return this.connections.relation(getUserSub(request), slug);
  }
}

/**
 * The writes, on the member-write ration plus the per-visitor limit, and
 * refused for a deleted account like every other member write.
 */
@Controller('me/connections')
@UseGuards(ClerkAuthGuard, AccountNotDeletedGuard, MemberWriteThrottleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class MyConnectionWritesController {
  constructor(private readonly connections: ConnectionsService) {}

  @Post()
  @WriteThrottle()
  send(@Req() request: AuthenticatedRequest, @Body() body: SendConnectionDto) {
    return this.connections.send(getUserSub(request), body.slug, body.note);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @WriteThrottle()
  accept(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.connections.accept(getUserSub(request), id);
  }

  @Post(':id/decline')
  @HttpCode(200)
  @WriteThrottle()
  decline(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.connections.decline(getUserSub(request), id);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @WriteThrottle()
  withdraw(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.connections.withdraw(getUserSub(request), id);
  }

  @Post(':id/disconnect')
  @HttpCode(200)
  @WriteThrottle()
  disconnect(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.connections.disconnect(getUserSub(request), id);
  }

  @Post('blocks')
  @HttpCode(200)
  @WriteThrottle()
  block(@Req() request: AuthenticatedRequest, @Body() body: BlockDto) {
    return this.connections.block(getUserSub(request), {
      ...(body.slug !== undefined ? { slug: body.slug } : {}),
      ...(body.connectionId !== undefined
        ? { connectionId: body.connectionId }
        : {}),
    });
  }

  @Delete('blocks/:id')
  @WriteThrottle()
  unblock(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.connections.unblock(getUserSub(request), id);
  }

  @Put('settings')
  @WriteThrottle()
  settings(
    @Req() request: AuthenticatedRequest,
    @Body() body: ConnectionSettingsDto,
  ) {
    return this.connections.updateSettings(getUserSub(request), {
      ...(body.openTo !== undefined ? { openTo: body.openTo } : {}),
      ...(body.contacts !== undefined ? { contacts: body.contacts } : {}),
    });
  }
}

/** Renaming the feature: the real Clerk admin role, like every setting. */
@Controller('admin/settings')
@UseGuards(ClerkAuthGuard, AdminRoleGuard, MemberWriteThrottleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class AdminConnectionTermsController {
  constructor(private readonly terms: ConnectionTermsService) {}

  @Put('connection-name')
  @WriteThrottle()
  rename(
    @Req() request: AuthenticatedRequest,
    @Body() body: ConnectionTermsDto,
  ) {
    return this.terms.setTerms(body.singular, body.plural, getUserSub(request));
  }
}
