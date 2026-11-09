import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ClerkAuthGuard, OptionalClerkAuthGuard } from '../auth/auth.guard';
import { getUserSub } from '../auth/auth.helpers';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { AdminRoleGuard } from '../auth/admin-role.guard';
import { PICTURE_THROTTLE, WriteThrottle } from '../config/throttle';
import { MemberWriteThrottleGuard } from './member-write-throttle.guard';
import {
  MemberJsonCacheInterceptor,
  NoStoreWhenSignedInInterceptor,
} from './no-store.interceptor';
import {
  AddBeliefTabDto,
  ChangeVisibilityDto,
  SetVotingInviteDto,
} from './members.dto';
import { MembersService } from './members.service';
import { MyMemberPageService } from './my-member-page.service';
import { OrgSettingsService } from './org-settings.service';
import { MAX_PICTURE_BYTES } from './picture-processing';
import { STORED_PICTURE_TYPE } from './picture-store.service';

/**
 * - public page: any cache must ask again each time (`no-cache`), so the
 *   access check runs on every load and a page made private stops at once;
 * - everything else: stored nowhere.
 */
export const PUBLIC_PICTURE_CACHE = 'public, no-cache';
export const PRIVATE_PICTURE_CACHE = 'private, no-store';

/** Reads about member pages; who is asking comes only from the verified token. */
@Controller('members')
@UseGuards(OptionalClerkAuthGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get('directory')
  @UseInterceptors(MemberJsonCacheInterceptor)
  async directory(@Req() request: AuthenticatedRequest) {
    return this.members.directory(await this.members.resolveViewer(request));
  }

  @Get('chats')
  @UseInterceptors(MemberJsonCacheInterceptor)
  async chats(@Req() request: AuthenticatedRequest) {
    return this.members.chats(await this.members.resolveViewer(request));
  }

  @Get('profiles/:slug')
  @UseInterceptors(MemberJsonCacheInterceptor)
  async profile(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
  ) {
    return this.members.profile(
      slug,
      await this.members.resolveViewer(request),
    );
  }

  /** Same access decision as the page; a client never names a file. */
  @Get('profiles/:slug/picture')
  @Throttle({ default: PICTURE_THROTTLE })
  async picture(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
    @Param('slug') slug: string,
  ) {
    const { picture, isPublic } = await this.members.picture(
      slug,
      await this.members.resolveViewer(request),
    );
    response.set({
      'Content-Type': STORED_PICTURE_TYPE,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': isPublic ? PUBLIC_PICTURE_CACHE : PRIVATE_PICTURE_CACHE,
    });
    // `end`, not `send`: Express would add its own ETag to a private picture.
    if (!isPublic) {
      response.status(200).end(picture.data);
      return;
    }
    // A plain image tag on the website is a cross-origin load of this server.
    const etag = `"${picture.fileId}"`;
    response.set({
      ETag: etag,
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    if (request.headers['if-none-match'] === etag) {
      response.status(304).end();
      return;
    }
    response.status(200).end(picture.data);
  }
}

/** The signed-in owner's tools for their own page. */
@Controller('me/member-page')
@UseGuards(ClerkAuthGuard, MemberWriteThrottleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class MyMemberPageController {
  constructor(private readonly page: MyMemberPageService) {}

  @Patch('visibility')
  @WriteThrottle()
  changeVisibility(
    @Req() request: AuthenticatedRequest,
    @Body() body: ChangeVisibilityDto,
  ) {
    return this.page.changeVisibility(getUserSub(request), body.visibility);
  }

  @Post('tabs')
  @WriteThrottle()
  addTab(@Req() request: AuthenticatedRequest, @Body() body: AddBeliefTabDto) {
    return this.page.addBeliefTab(getUserSub(request), body);
  }

  @Put('picture')
  @WriteThrottle()
  @UseInterceptors(
    FileInterceptor('picture', {
      limits: { fileSize: MAX_PICTURE_BYTES, files: 1, fields: 0 },
    }),
  )
  replacePicture(
    @Req() request: AuthenticatedRequest,
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ) {
    return this.page.replacePicture(getUserSub(request), file?.buffer);
  }
}

/**
 * Admin-only settings: the real Clerk admin role, never a token claim. The
 * admin screen for them is Chunk 12.
 */
@Controller('admin/settings')
@UseGuards(ClerkAuthGuard, AdminRoleGuard, MemberWriteThrottleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class AdminSettingsController {
  constructor(private readonly settings: OrgSettingsService) {}

  @Put('voting-invite')
  @WriteThrottle()
  setVotingInvite(
    @Req() request: AuthenticatedRequest,
    @Body() body: SetVotingInviteDto,
  ) {
    return this.settings.setVotingInvite(body.inviteUrl, getUserSub(request));
  }
}
