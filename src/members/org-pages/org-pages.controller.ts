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
import { OrgPageIdGuard } from './org-page-id.guard';
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
 *
 * Not-found contract (round 2, N3/N4):
 * - an id that is not one of ORG's pages: 404 from `OrgPageIdGuard`, before
 *   anything else (sign-in, ration, query, body);
 * - a known page that is not published: 404 from the services for every
 *   read, vote and comment, while withdrawing a vote still answers 200.
 */
@Controller('members/org-pages/:pageId')
@UseGuards(OrgPageIdGuard, OptionalClerkAuthGuard)
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
  async history(
    @Req() request: AuthenticatedRequest,
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Query() query: CommentHistoryQueryDto,
  ) {
    // The reader decides only one thing here: an admin also reads a comment
    // a moderator hid (Chunk 13).
    return this.comments.orgHistory(
      pageId,
      commentId,
      query.page,
      await this.members.resolveViewer(request),
    );
  }
}

/**
 * Voting and commenting on ORG's own pages. Signed in, and rationed with the
 * other member-page writes. Editing and removing a comment use the general
 * `/me/comments/:commentId` routes. The page id is checked first, before
 * sign-in and the ration (`OrgPageIdGuard`).
 */
@Controller('me/org-pages/:pageId')
@UseGuards(OrgPageIdGuard, ClerkAuthGuard, MemberWriteThrottleGuard)
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

  /**
   * Takes the voter's vote back. Unlike a vote or a comment, this answers
   * 200 on a known page that is no longer published (round 2, N4): taking a
   * vote back never depends on the page's state, as on a belief. The answer
   * carries the page's votes only while it is published.
   */
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
