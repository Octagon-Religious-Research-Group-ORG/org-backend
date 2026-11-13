import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
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
import { CommentWritersService } from '../comments/comment-writers';
import { CommentHistoryQueryDto } from '../comments/comments.dto';
import { CommentsService } from '../comments/comments.service';
import { MemberWriteThrottleGuard } from '../member-write-throttle.guard';
import { MembersService } from '../members.service';
import {
  MemberJsonCacheInterceptor,
  NoStoreWhenSignedInInterceptor,
} from '../no-store.interceptor';
import { VotesService } from '../votes/votes.service';
import { OrgPagesService } from './org-pages.service';
import {
  NewOrgPageCommentDto,
  OrgPageVoteDto,
  OrgThreadQueryDto,
} from './org-pages.dto';

/**
 * Votes and comments on ORG's own published pages (Chunk 10b), for any
 * reader, signed in or not. Answers depend on who asks (their own vote, who
 * may write, which authors they may see named): never shared by a cache.
 */
@Controller('members/org-pages/:pageId')
@UseGuards(OptionalClerkAuthGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor, MemberJsonCacheInterceptor)
export class OrgPageReactionsController {
  constructor(
    private readonly members: MembersService,
    private readonly votes: VotesService,
    private readonly comments: CommentsService,
    private readonly writers: CommentWritersService,
  ) {}

  @Get('votes')
  async votesOn(
    @Req() request: AuthenticatedRequest,
    @Param('pageId') pageId: string,
  ) {
    return this.votes.orgPageVotes(
      await this.members.resolveViewer(request),
      pageId,
    );
  }

  @Get('comments')
  async thread(
    @Req() request: AuthenticatedRequest,
    @Param('pageId') pageId: string,
    @Query() query: OrgThreadQueryDto,
  ) {
    const viewer = await this.members.resolveViewer(request);
    return this.comments.orgThread(
      pageId,
      viewer,
      query.after,
      await this.writers.writeStatus(viewer),
    );
  }

  @Get('comments/:commentId/history')
  history(
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Query() query: CommentHistoryQueryDto,
  ) {
    return this.comments.orgHistory(pageId, commentId, query.page);
  }
}

/**
 * Voting and commenting on ORG's own pages. Signed in, and rationed with the
 * other member-page writes. Editing and removing a comment use the general
 * `/me/comments/:commentId` routes.
 */
@Controller('me/org-pages/:pageId')
@UseGuards(ClerkAuthGuard, MemberWriteThrottleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class OrgPageReactionWritesController {
  constructor(
    private readonly members: MembersService,
    private readonly votes: VotesService,
    private readonly comments: CommentsService,
    private readonly writers: CommentWritersService,
    private readonly orgPages: OrgPagesService,
  ) {}

  /** Casts, changes, or confirms on the current published revision. */
  @Put('vote')
  @WriteThrottle()
  async cast(
    @Req() request: AuthenticatedRequest,
    @Param('pageId') pageId: string,
    @Body() body: OrgPageVoteDto,
  ) {
    return this.votes.castOnOrgPage(await this.members.resolveViewer(request), {
      pageId,
      value: body.value,
      baseSeq: body.baseSeq,
    });
  }

  @Delete('vote')
  @WriteThrottle()
  async withdraw(
    @Req() request: AuthenticatedRequest,
    @Param('pageId') pageId: string,
  ) {
    const viewer = await this.members.resolveViewer(request);
    return this.votes.withdrawOnOrgPage(
      { ...viewer, userId: getUserSub(request) },
      pageId,
    );
  }

  /**
   * Answers with the comment as the writer now sees it. An unknown or
   * unpublished page is 404 for everyone, before who writes is checked
   * (review MEDIUM 1).
   */
  @Post('comments')
  @WriteThrottle()
  async create(
    @Req() request: AuthenticatedRequest,
    @Param('pageId') pageId: string,
    @Body() body: NewOrgPageCommentDto,
  ) {
    await this.orgPages.find(pageId);
    const writer = await this.writers.requireWriter(request);
    const made = await this.comments.createOnOrgPage(writer, {
      pageId,
      body: body.body,
      ...(body.parentCommentId !== undefined
        ? { parentCommentId: body.parentCommentId }
        : {}),
      ...(body.stance !== undefined ? { stance: body.stance } : {}),
    });
    const comment = await this.comments.viewOne(made.commentId, writer);
    return { ...made, ...(comment ? { comment } : {}) };
  }
}
