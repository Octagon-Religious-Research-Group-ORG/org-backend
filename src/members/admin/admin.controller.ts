import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AdminInboxService } from '../../admin-inbox/admin-inbox.service';
import { AdminRoleGuard } from '../../auth/admin-role.guard';
import { ClerkAuthGuard } from '../../auth/auth.guard';
import { getUserSub } from '../../auth/auth.helpers';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { WriteThrottle } from '../../config/throttle';
import { MemberWriteThrottleGuard } from '../member-write-throttle.guard';
import { MembersService } from '../members.service';
import { NoStoreWhenSignedInInterceptor } from '../no-store.interceptor';
import { OrgSettingsService } from '../org-settings.service';
import { AdminLogService } from './admin-log.service';
import { AdminMembersService } from './admin-members.service';
import { AdminRolesService } from './admin-roles.service';
import {
  EamRequestDto,
  InboxQueryDto,
  INVITATION_ID_PATTERN,
  InviteDto,
  MembersQueryDto,
  PageQueryDto,
  ReasonDto,
  RoleChangeDto,
  USER_ID_PATTERN,
} from './admin.dto';
import { EamRequestsService } from './eam-requests.service';

export const NO_SUCH_ACCOUNT = 'That account does not exist.';

/** A Clerk user id from a URL; anything else is "no such account". */
function userIdParam(value: string) {
  if (!USER_ID_PATTERN.test(value)) {
    throw new NotFoundException(NO_SUCH_ACCOUNT);
  }
  return value;
}

/**
 * The admin dashboard's reads (Chunk 12). The real Clerk admin role, never a
 * token claim; nothing stored by any cache.
 */
@Controller('admin')
@UseGuards(ClerkAuthGuard, AdminRoleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class AdminDashboardController {
  constructor(
    private readonly roles: AdminRolesService,
    private readonly members: AdminMembersService,
    private readonly log: AdminLogService,
    private readonly inbox: AdminInboxService,
    private readonly settings: OrgSettingsService,
  ) {}

  @Get('roles')
  admins(@Req() request: AuthenticatedRequest) {
    return this.roles.admins(getUserSub(request));
  }

  @Get('invitations')
  async invitations() {
    return { invitations: await this.roles.invitations() };
  }

  @Get('members')
  memberPages(@Query() query: MembersQueryDto) {
    return this.members.list(query.status ?? 'all', query.q, query.page ?? 1);
  }

  @Get('log')
  moderationLog(@Query() query: PageQueryDto) {
    return this.log.page(query.page ?? 1);
  }

  @Get('inbox')
  inboxEntries(@Query() query: InboxQueryDto) {
    return this.inbox.list(query.status ?? 'open', query.page ?? 1);
  }

  @Get('settings')
  allSettings() {
    return this.settings.adminView();
  }
}

/** The admin dashboard's writes: each logged, and on the member-write ration. */
@Controller('admin')
@UseGuards(ClerkAuthGuard, AdminRoleGuard, MemberWriteThrottleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class AdminDashboardWritesController {
  constructor(
    private readonly roles: AdminRolesService,
    private readonly members: AdminMembersService,
    private readonly inbox: AdminInboxService,
  ) {}

  @Post('roles/:userId/promote')
  @WriteThrottle()
  promote(
    @Req() request: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Body() body: RoleChangeDto,
  ) {
    return this.roles.promote(
      getUserSub(request),
      userIdParam(userId),
      body.reason,
    );
  }

  @Post('roles/:userId/demote')
  @WriteThrottle()
  demote(
    @Req() request: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Body() body: RoleChangeDto,
  ) {
    return this.roles.demote(
      getUserSub(request),
      userIdParam(userId),
      body.reason,
    );
  }

  @Post('invitations')
  @WriteThrottle()
  invite(@Req() request: AuthenticatedRequest, @Body() body: InviteDto) {
    return this.roles.invite(
      getUserSub(request),
      body.email,
      body.as,
      body.reason,
    );
  }

  @Delete('invitations/:invitationId')
  @WriteThrottle()
  revoke(
    @Req() request: AuthenticatedRequest,
    @Param('invitationId') invitationId: string,
  ) {
    if (!INVITATION_ID_PATTERN.test(invitationId)) {
      throw new NotFoundException('That invitation does not exist.');
    }
    return this.roles.revokeInvitation(getUserSub(request), invitationId);
  }

  @Post('members/:slug/approve')
  @WriteThrottle()
  approve(@Req() request: AuthenticatedRequest, @Param('slug') slug: string) {
    return this.members.approve(getUserSub(request), slug);
  }

  @Post('members/:slug/reject')
  @WriteThrottle()
  reject(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Body() body: ReasonDto,
  ) {
    return this.members.reject(getUserSub(request), slug, body.reason);
  }

  @Post('members/:slug/remove')
  @WriteThrottle()
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Body() body: ReasonDto,
  ) {
    return this.members.remove(getUserSub(request), slug, body.reason);
  }

  @Post('members/:slug/restore')
  @WriteThrottle()
  restore(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Body() body: ReasonDto,
  ) {
    return this.members.restore(getUserSub(request), slug, body.reason);
  }

  @Post('inbox/:entryId/handled')
  @WriteThrottle()
  handled(
    @Req() request: AuthenticatedRequest,
    @Param('entryId') entryId: string,
  ) {
    return this.inbox.markHandled(getUserSub(request), entryId);
  }

  @Post('inbox/:entryId/reset-eam')
  @WriteThrottle()
  resetEam(
    @Req() request: AuthenticatedRequest,
    @Param('entryId') entryId: string,
  ) {
    return this.inbox.resetEam(getUserSub(request), entryId);
  }
}

/** The member's "Request EaM" button: its state. */
@Controller('me/eam-request')
@UseGuards(ClerkAuthGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class MyEamRequestController {
  constructor(
    private readonly members: MembersService,
    private readonly eam: EamRequestsService,
  ) {}

  @Get()
  async status(@Req() request: AuthenticatedRequest) {
    const viewer = await this.members.resolveViewer(request);
    return this.eam.status({ ...viewer, userId: getUserSub(request) });
  }
}

/** Pressing "Request EaM": once per member, on the member-write ration. */
@Controller('me/eam-request')
@UseGuards(ClerkAuthGuard, MemberWriteThrottleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class MyEamRequestWritesController {
  constructor(
    private readonly members: MembersService,
    private readonly eam: EamRequestsService,
  ) {}

  @Post()
  @WriteThrottle()
  async request(
    @Req() request: AuthenticatedRequest,
    @Body() body: EamRequestDto,
  ) {
    const viewer = await this.members.resolveViewer(request);
    return this.eam.request(
      { ...viewer, userId: getUserSub(request) },
      body.note,
    );
  }
}
