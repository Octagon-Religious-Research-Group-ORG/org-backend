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
import type { Viewer } from '../profile-access';
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
    private readonly writers: CommentWritersService,
  ) {}

  @Get()
  async thread(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Query() query: ThreadQueryDto,
  ) {
    const viewer = await this.members.resolveViewer(request);
    return this.comments.thread(
      slug,
      viewer,
      query.tab,
      query.after,
      await this.writers.writeStatus(viewer),
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
    private readonly members: MembersService,
  ) {}

  /** Every write answers with the comment as the writer now sees it. */
  private async withView<T extends object>(
    result: T,
    commentId: string,
    viewer: Viewer,
    viewerIsOwner = false,
  ) {
    const comment = await this.comments.viewOne(
      commentId,
      viewer,
      viewerIsOwner,
    );
    return { ...result, ...(comment ? { comment } : {}) };
  }

  @Post('comments')
  @WriteThrottle()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: NewCommentDto,
  ) {
    const writer = await this.writers.requireWriter(request);
    const made = await this.comments.create(writer, {
      slug: body.slug,
      body: body.body,
      ...(body.tabId !== undefined ? { tabId: body.tabId } : {}),
      ...(body.parentCommentId !== undefined
        ? { parentCommentId: body.parentCommentId }
        : {}),
      ...(body.stance !== undefined ? { stance: body.stance } : {}),
    });
    return this.withView(made, made.commentId, writer);
  }

  @Put('comments/:commentId')
  @WriteThrottle()
  async edit(
    @Req() request: AuthenticatedRequest,
    @Param('commentId') commentId: string,
    @Body() body: EditCommentDto,
  ) {
    const writer = await this.writers.requireWriter(request);
    const saved = await this.comments.edit(
      writer,
      commentId,
      body.body,
      body.baseSeq,
    );
    return this.withView(saved, commentId, writer);
  }

  /** Soft: the text is kept (plan §2b); its own author only. */
  @Delete('comments/:commentId')
  @WriteThrottle()
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('commentId') commentId: string,
  ) {
    const removed = await this.comments.remove(getUserSub(request), commentId);
    return this.withView(
      removed,
      commentId,
      await this.members.resolveViewer(request),
    );
  }

  @Post('suggestions')
  @WriteThrottle()
  async suggest(
    @Req() request: AuthenticatedRequest,
    @Body() body: NewSuggestionDto,
  ) {
    const writer = await this.writers.requireWriter(request);
    const made = await this.suggestions.suggest(writer, {
      slug: body.slug,
      tabId: body.tabId,
      text: body.text,
      baseSeq: body.baseSeq,
      ...(body.note !== undefined ? { note: body.note } : {}),
    });
    return this.withView(made, made.commentId, writer);
  }

  /** The page owner only: their own page's suggestion. */
  @Post('member-page/suggestions/:commentId/accept')
  @WriteThrottle()
  async accept(
    @Req() request: AuthenticatedRequest,
    @Param('commentId') commentId: string,
  ) {
    const accepted = await this.suggestions.accept(
      getUserSub(request),
      commentId,
    );
    return this.withView(
      accepted,
      commentId,
      await this.members.resolveViewer(request),
      true,
    );
  }

  @Post('member-page/suggestions/:commentId/decline')
  @WriteThrottle()
  async decline(
    @Req() request: AuthenticatedRequest,
    @Param('commentId') commentId: string,
  ) {
    const declined = await this.suggestions.decline(
      getUserSub(request),
      commentId,
    );
    return this.withView(
      declined,
      commentId,
      await this.members.resolveViewer(request),
      true,
    );
  }
}
