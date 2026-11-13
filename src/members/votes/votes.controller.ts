import {
  Body,
  Controller,
  Delete,
  Get,
  Put,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ClerkAuthGuard, OptionalClerkAuthGuard } from '../../auth/auth.guard';
import { getUserSub } from '../../auth/auth.helpers';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { WriteThrottle } from '../../config/throttle';
import { MemberWriteThrottleGuard } from '../member-write-throttle.guard';
import { MembersService } from '../members.service';
import {
  MemberJsonCacheInterceptor,
  NoStoreWhenSignedInInterceptor,
} from '../no-store.interceptor';
import { AgreedQueryDto, CastVoteDto, WithdrawVoteDto } from './votes.dto';
import { VotesService } from './votes.service';

/**
 * The Beliefs page section (Chunk 10). Answers depend on who asks (which
 * pages they may read, their own votes): never shared by a cache.
 */
@Controller('members/agreed-beliefs')
@UseGuards(OptionalClerkAuthGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor, MemberJsonCacheInterceptor)
export class AgreedBeliefsController {
  constructor(
    private readonly members: MembersService,
    private readonly votes: VotesService,
  ) {}

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query() query: AgreedQueryDto,
  ) {
    return this.votes.agreedPage(
      await this.members.resolveViewer(request),
      query.after,
    );
  }
}

/**
 * Voting. Signed in, and rationed per visitor and per account with the other
 * member-page writes. Who may vote is decided by `VotersService` from the
 * token, the database and Clerk only.
 */
@Controller('me/votes')
@UseGuards(ClerkAuthGuard, MemberWriteThrottleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class VoteWritesController {
  constructor(
    private readonly members: MembersService,
    private readonly votes: VotesService,
  ) {}

  /** Casts, changes, or confirms on the current wording. */
  @Put()
  @WriteThrottle()
  async cast(@Req() request: AuthenticatedRequest, @Body() body: CastVoteDto) {
    return this.votes.cast(await this.members.resolveViewer(request), {
      slug: body.slug,
      tabId: body.tabId,
      value: body.value,
      baseSeq: body.baseSeq,
    });
  }

  @Delete()
  @WriteThrottle()
  async withdraw(
    @Req() request: AuthenticatedRequest,
    @Body() body: WithdrawVoteDto,
  ) {
    const viewer = await this.members.resolveViewer(request);
    return this.votes.withdraw(
      { ...viewer, userId: getUserSub(request) },
      body.slug,
      body.tabId,
    );
  }
}
