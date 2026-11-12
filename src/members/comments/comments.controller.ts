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
import { MemberWriteThrottleGuard } from '../member-write-throttle.guard';
import { MembersService } from '../members.service';
import {
  MemberJsonCacheInterceptor,
  NoStoreWhenSignedInInterceptor,
} from '../no-store.interceptor';
import { CommentWritersService } from './comment-writers';
import {
  CommentHistoryQueryDto,
  EditCommentDto,
  NewCommentDto,
  NewSuggestionDto,
  ThreadQueryDto,
} from './comments.dto';
import { CommentsService } from './comments.service';
import { SuggestionsService } from './suggestions.service';

/**
 * Reading comment threads (Chunk 9): exactly who can read the whole page.
 * Answers depend on who asks: never shared by a cache.
 */
@Controller('members/profiles/:slug/comments')
@UseGuards(OptionalClerkAuthGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor, MemberJsonCacheInterceptor)
export class CommentThreadsController {
  constructor(
    private readonly members: MembersService,
    private readonly comments: CommentsService,
  ) {}

  @Get()
  async thread(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Query() query: ThreadQueryDto,
  ) {
    return this.comments.thread(
      slug,
      await this.members.resolveViewer(request),
      query.tab,
      query.after,
    );
  }

  @Get(':commentId/history')
  async history(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Param('commentId') commentId: string,
    @Query() query: CommentHistoryQueryDto,
  ) {
    return this.comments.history(
      slug,
      commentId,
      await this.members.resolveViewer(request),
      query.page,
    );
  }
}

/**
 * Writing comments and suggestions. Signed in, and every route rationed per
 * visitor and per account. Who may write is decided by
 * `CommentWritersService` from the token, the database and Clerk only.
 */
@Controller('me')
@UseGuards(ClerkAuthGuard, MemberWriteThrottleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class CommentWritesController {
  constructor(
    private readonly writers: CommentWritersService,
    private readonly comments: CommentsService,
    private readonly suggestions: SuggestionsService,
  ) {}

  @Post('comments')
  @WriteThrottle()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: NewCommentDto,
  ) {
    return this.comments.create(await this.writers.requireWriter(request), {
      slug: body.slug,
      body: body.body,
      ...(body.tabId !== undefined ? { tabId: body.tabId } : {}),
      ...(body.parentCommentId !== undefined
        ? { parentCommentId: body.parentCommentId }
        : {}),
    });
  }

  @Put('comments/:commentId')
  @WriteThrottle()
  async edit(
    @Req() request: AuthenticatedRequest,
    @Param('commentId') commentId: string,
    @Body() body: EditCommentDto,
  ) {
    return this.comments.edit(
      await this.writers.requireWriter(request),
      commentId,
      body.body,
      body.baseSeq,
    );
  }

  /** Soft: the text is kept (plan §2b); its own author only. */
  @Delete('comments/:commentId')
  @WriteThrottle()
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('commentId') commentId: string,
  ) {
    return this.comments.remove(getUserSub(request), commentId);
  }

  @Post('suggestions')
  @WriteThrottle()
  async suggest(
    @Req() request: AuthenticatedRequest,
    @Body() body: NewSuggestionDto,
  ) {
    return this.suggestions.suggest(await this.writers.requireWriter(request), {
      slug: body.slug,
      tabId: body.tabId,
      text: body.text,
      baseSeq: body.baseSeq,
      ...(body.note !== undefined ? { note: body.note } : {}),
    });
  }

  /** The page owner only: their own page's suggestion. */
  @Post('member-page/suggestions/:commentId/accept')
  @WriteThrottle()
  accept(
    @Req() request: AuthenticatedRequest,
    @Param('commentId') commentId: string,
  ) {
    return this.suggestions.accept(getUserSub(request), commentId);
  }

  @Post('member-page/suggestions/:commentId/decline')
  @WriteThrottle()
  decline(
    @Req() request: AuthenticatedRequest,
    @Param('commentId') commentId: string,
  ) {
    return this.suggestions.decline(getUserSub(request), commentId);
  }
}
