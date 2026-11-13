import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminRoleGuard } from '../../auth/admin-role.guard';
import { ClerkAuthGuard } from '../../auth/auth.guard';
import { getUserSub } from '../../auth/auth.helpers';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { CLAIM_REQUEST_THROTTLE, WriteThrottle } from '../../config/throttle';
import { MemberWriteThrottleGuard } from '../member-write-throttle.guard';
import { MembersService } from '../members.service';
import { NoStoreWhenSignedInInterceptor } from '../no-store.interceptor';
import { ClaimRequestThrottleGuard } from './claim-request-throttle.guard';
import {
  ClaimListQueryDto,
  LinkCommentsDto,
  NewClaimDto,
  RejectClaimDto,
} from './claims.dto';
import { ClaimsService } from './claims.service';
import { LegacyLinksService } from './legacy-links.service';

/** The signed-in reader's own claim requests (Chunk 11): theirs only. */
@Controller('me/claims')
@UseGuards(ClerkAuthGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class MyClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @Get()
  mine(@Req() request: AuthenticatedRequest) {
    return this.claims.mine(getUserSub(request));
  }
}

/** Asking for a page and taking a request back. */
@Controller('me/claims')
@UseGuards(ClerkAuthGuard, MemberWriteThrottleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class MyClaimWritesController {
  constructor(
    private readonly members: MembersService,
    private readonly claims: ClaimsService,
  ) {}

  @Post()
  @Throttle({ default: CLAIM_REQUEST_THROTTLE })
  @UseGuards(ClaimRequestThrottleGuard)
  async request(
    @Req() request: AuthenticatedRequest,
    @Body() body: NewClaimDto,
  ) {
    const viewer = await this.members.resolveViewer(request);
    return this.claims.request(
      { ...viewer, userId: getUserSub(request) },
      body.slug,
      body.message,
    );
  }

  @Delete(':claimId')
  @WriteThrottle()
  withdraw(
    @Req() request: AuthenticatedRequest,
    @Param('claimId') claimId: string,
  ) {
    return this.claims.withdraw(getUserSub(request), claimId);
  }
}

/**
 * The admins' claims queue: the real Clerk admin role, never a token claim.
 * The full admin dashboard is Chunk 12.
 */
@Controller('admin/claims')
@UseGuards(ClerkAuthGuard, AdminRoleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class AdminClaimsController {
  constructor(
    private readonly claims: ClaimsService,
    private readonly links: LegacyLinksService,
  ) {}

  @Get()
  list(@Query() query: ClaimListQueryDto) {
    return this.claims.adminList(query.status ?? 'pending');
  }

  @Get(':claimId/legacy-comments')
  legacyComments(
    @Req() request: AuthenticatedRequest,
    @Param('claimId') claimId: string,
  ) {
    return this.links.candidates(getUserSub(request), claimId);
  }
}

/** Admin decisions; they share the member-write ration. */
@Controller('admin/claims')
@UseGuards(ClerkAuthGuard, AdminRoleGuard, MemberWriteThrottleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class AdminClaimWritesController {
  constructor(
    private readonly claims: ClaimsService,
    private readonly links: LegacyLinksService,
  ) {}

  @Post(':claimId/approve')
  @WriteThrottle()
  approve(
    @Req() request: AuthenticatedRequest,
    @Param('claimId') claimId: string,
  ) {
    return this.claims.approve(getUserSub(request), claimId);
  }

  @Post(':claimId/reject')
  @WriteThrottle()
  reject(
    @Req() request: AuthenticatedRequest,
    @Param('claimId') claimId: string,
    @Body() body: RejectClaimDto,
  ) {
    return this.claims.reject(getUserSub(request), claimId, body.reason);
  }

  @Post(':claimId/legacy-comments/link')
  @WriteThrottle()
  link(
    @Req() request: AuthenticatedRequest,
    @Param('claimId') claimId: string,
    @Body() body: LinkCommentsDto,
  ) {
    return this.links.link(getUserSub(request), claimId, body.commentIds);
  }

  @Post(':claimId/legacy-comments/unlink')
  @WriteThrottle()
  unlink(
    @Req() request: AuthenticatedRequest,
    @Param('claimId') claimId: string,
    @Body() body: LinkCommentsDto,
  ) {
    return this.links.unlink(getUserSub(request), claimId, body.commentIds);
  }
}
