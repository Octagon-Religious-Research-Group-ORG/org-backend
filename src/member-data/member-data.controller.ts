import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle, seconds, hours } from '@nestjs/throttler';
import type { Response } from 'express';
import { AdminRoleGuard } from '../auth/admin-role.guard';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { getUserSub } from '../auth/auth.helpers';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { WriteThrottle } from '../config/throttle';
import { PageQueryDto, ReasonDto } from '../members/admin/admin.dto';
import { MemberWriteThrottleGuard } from '../members/member-write-throttle.guard';
import { MembersService } from '../members/members.service';
import { NoStoreWhenSignedInInterceptor } from '../members/no-store.interceptor';
import { AccountThrottleGuard } from '../membership/account-throttle.guard';
import { MemberExportService } from './member-export.service';
import { DeletePageDto } from './member-data.dto';
import { MemberPurgeService } from './member-purge.service';
import { PageDeletionService } from './page-deletion.service';

/** Exports per visitor address per minute. */
export const EXPORT_THROTTLE = { ttl: seconds(60), limit: 3 };

/** Exports per account per day: each reads everything the account holds. */
export const EXPORT_ACCOUNT_THROTTLE = { ttl: hours(24), limit: 5 };

export const EXPORT_DAILY_LIMIT_CODE = 'EXPORT_DAILY_LIMIT';

/** The export's own daily ration per account, apart from page writes. */
@Injectable()
export class ExportThrottleGuard extends AccountThrottleGuard {
  protected override readonly ration = {
    ...EXPORT_ACCOUNT_THROTTLE,
    code: EXPORT_DAILY_LIMIT_CODE,
    message:
      "You've downloaded your data the most times allowed today. Please come back tomorrow.",
  };
}

/** A download's file name: the day, nothing about the member. */
export function exportFileName(now: Date): string {
  return `org-my-data-${now.toISOString().slice(0, 10)}.zip`;
}

/**
 * The member's "Your data" area (Chunk 17). Only ever the signed-in
 * account's own data: there is no account id in any route, so an admin
 * gets their own export here and nobody else's.
 */
@Controller('me/data')
@UseGuards(ClerkAuthGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class MyDataController {
  constructor(
    private readonly deletion: PageDeletionService,
    private readonly exporter: MemberExportService,
    private readonly members: MembersService,
  ) {}

  @Get()
  status(@Req() request: AuthenticatedRequest) {
    return this.deletion.status(getUserSub(request));
  }

  @Get('export')
  @UseGuards(ExportThrottleGuard)
  @Throttle({ default: EXPORT_THROTTLE })
  async download(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ) {
    const userId = getUserSub(request);
    const viewer = await this.members.resolveViewer(request);
    const now = new Date();
    const { zip } = await this.exporter.build(userId, viewer, now);
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${exportFileName(now)}"`,
    );
    response.send(Buffer.from(zip));
  }
}

/** The writes: their own per-visitor and per-account rations. */
@Controller('me/data')
@UseGuards(ClerkAuthGuard, MemberWriteThrottleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class MyDataWritesController {
  constructor(private readonly deletion: PageDeletionService) {}

  @Post('delete-page')
  @HttpCode(200)
  @WriteThrottle()
  deletePage(
    @Req() request: AuthenticatedRequest,
    @Body() body: DeletePageDto,
  ) {
    return this.deletion.deleteOwn(getUserSub(request), body.confirm);
  }

  @Post('undo-delete')
  @HttpCode(200)
  @WriteThrottle()
  undo(@Req() request: AuthenticatedRequest) {
    return this.deletion.undoOwn(getUserSub(request));
  }
}

/** Deleted pages for admins: the list, restore, and the purge's dry run. */
@Controller('admin/deleted-pages')
@UseGuards(ClerkAuthGuard, AdminRoleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class AdminDeletedPagesController {
  constructor(
    private readonly deletion: PageDeletionService,
    private readonly purge: MemberPurgeService,
  ) {}

  @Get()
  list(@Query() query: PageQueryDto) {
    return this.deletion.list(query.page ?? 1);
  }

  @Get('purge-due')
  due() {
    return this.purge.due();
  }
}

@Controller('admin/deleted-pages')
@UseGuards(ClerkAuthGuard, AdminRoleGuard, MemberWriteThrottleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class AdminDeletedPageWritesController {
  constructor(private readonly deletion: PageDeletionService) {}

  @Post(':slug/restore')
  @HttpCode(200)
  @WriteThrottle()
  restore(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Body() body: ReasonDto,
  ) {
    return this.deletion.adminRestore(getUserSub(request), slug, body.reason);
  }
}
