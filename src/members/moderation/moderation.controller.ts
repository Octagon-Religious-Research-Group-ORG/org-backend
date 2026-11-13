import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AdminRoleGuard } from '../../auth/admin-role.guard';
import { ClerkAuthGuard } from '../../auth/auth.guard';
import { getUserSub } from '../../auth/auth.helpers';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { WriteThrottle } from '../../config/throttle';
import {
  REPORT_TARGET_TYPES,
  type ReportTargetType,
} from '../../moderation/schemas/report.schema';
import { ReasonDto } from '../admin/admin.dto';
import { CommentWritersService } from '../comments/comment-writers';
import { ID_PATTERN } from '../comments/comments.dto';
import { MemberWriteThrottleGuard } from '../member-write-throttle.guard';
import { NoStoreWhenSignedInInterceptor } from '../no-store.interceptor';
import {
  type CommentAction,
  ModerationQueueService,
  TARGET_NOT_FOUND,
} from './moderation-queue.service';
import { NewReportDto, PAGE_ID_PATTERN, QueueQueryDto } from './moderation.dto';
import { ReportsService } from './reports.service';

/** A comment id from a URL; anything else is "no such comment". */
function commentIdParam(value: string) {
  if (!ID_PATTERN.test(value)) throw new NotFoundException(TARGET_NOT_FOUND);
  return value;
}

/** A target from a URL; anything malformed is the same 404. */
function targetParams(type: string, id: string) {
  const known = (REPORT_TARGET_TYPES as readonly string[]).includes(type);
  const valid =
    known &&
    (type === 'comment' ? ID_PATTERN.test(id) : PAGE_ID_PATTERN.test(id));
  if (!valid) throw new NotFoundException('There are no reports on that.');
  return { targetType: type as ReportTargetType, targetId: id };
}

/**
 * "Report" on a comment or a member page (Chunk 13). Signed in, on the
 * member-write ration plus the per-visitor limit; the answer is never stored
 * by a cache and says nothing about other reports.
 */
@Controller('me/reports')
@UseGuards(ClerkAuthGuard, MemberWriteThrottleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class MyReportWritesController {
  constructor(
    private readonly writers: CommentWritersService,
    private readonly reports: ReportsService,
  ) {}

  @Post()
  @WriteThrottle()
  async report(
    @Req() request: AuthenticatedRequest,
    @Body() body: NewReportDto,
  ) {
    const writer = await this.writers.requireWriter(request);
    return this.reports.report(writer, {
      targetType: body.targetType,
      reason: body.reason,
      ...(body.commentId !== undefined ? { commentId: body.commentId } : {}),
      ...(body.slug !== undefined ? { slug: body.slug } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
    });
  }
}

/** The moderation queue (Chunk 13): admins only, never cached. */
@Controller('admin/moderation')
@UseGuards(ClerkAuthGuard, AdminRoleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class AdminModerationController {
  constructor(private readonly queue: ModerationQueueService) {}

  @Get('queue')
  list(@Req() request: AuthenticatedRequest, @Query() query: QueueQueryDto) {
    return this.queue.queue(
      getUserSub(request),
      query.status ?? 'open',
      query.page ?? 1,
    );
  }
}

/**
 * The moderator's actions: each with a reason, logged in the same
 * transaction, on the member-write ration and the per-visitor limit.
 */
@Controller('admin/moderation')
@UseGuards(ClerkAuthGuard, AdminRoleGuard, MemberWriteThrottleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class AdminModerationWritesController {
  constructor(private readonly queue: ModerationQueueService) {}

  private act(
    request: AuthenticatedRequest,
    commentId: string,
    action: CommentAction,
    body: ReasonDto,
  ) {
    return this.queue.moderateComment(
      getUserSub(request),
      commentIdParam(commentId),
      action,
      body.reason,
    );
  }

  @Post('comments/:commentId/hide')
  @WriteThrottle()
  hide(
    @Req() request: AuthenticatedRequest,
    @Param('commentId') commentId: string,
    @Body() body: ReasonDto,
  ) {
    return this.act(request, commentId, 'hide', body);
  }

  @Post('comments/:commentId/remove')
  @WriteThrottle()
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('commentId') commentId: string,
    @Body() body: ReasonDto,
  ) {
    return this.act(request, commentId, 'remove', body);
  }

  @Post('comments/:commentId/restore')
  @WriteThrottle()
  restore(
    @Req() request: AuthenticatedRequest,
    @Param('commentId') commentId: string,
    @Body() body: ReasonDto,
  ) {
    return this.act(request, commentId, 'restore', body);
  }

  @Post(':targetType/:targetId/dismiss')
  @WriteThrottle()
  dismiss(
    @Req() request: AuthenticatedRequest,
    @Param('targetType') targetType: string,
    @Param('targetId') targetId: string,
    @Body() body: ReasonDto,
  ) {
    const target = targetParams(targetType, targetId);
    return this.queue.dismiss(
      getUserSub(request),
      target.targetType,
      target.targetId,
      body.reason,
    );
  }
}
