import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
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
  EditTextDto,
  EditTitleDto,
  HistoryQueryDto,
  MoveTabDto,
  SetVotingInviteDto,
  TabHistoryQueryDto,
} from './members.dto';
import { VoteEligibilityDto } from './votes/votes.dto';
import { VotesService } from './votes/votes.service';
import { MemberHistoryService } from './member-history.service';
import { MemberPageEditorService } from './member-page-editor.service';
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
  constructor(
    private readonly members: MembersService,
    private readonly history: MemberHistoryService,
    private readonly votes: VotesService,
  ) {}

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
    const viewer = await this.members.resolveViewer(request);
    return this.votes.withVotes(
      await this.members.profile(slug, viewer),
      viewer,
    );
  }

  /** Readable by exactly who can read the page now. */
  @Get('profiles/:slug/bio/history')
  @UseInterceptors(MemberJsonCacheInterceptor)
  async bioHistory(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Query() query: HistoryQueryDto,
  ) {
    return this.history.bioHistory(
      slug,
      await this.members.resolveViewer(request),
      query.page,
    );
  }

  /** A removed belief's history: its owner and admins only. */
  @Get('profiles/:slug/tabs/:tabId/history')
  @UseInterceptors(MemberJsonCacheInterceptor)
  async tabHistory(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Param('tabId') tabId: string,
    @Query() query: TabHistoryQueryDto,
  ) {
    return this.history.tabHistory(
      slug,
      tabId,
      await this.members.resolveViewer(request),
      query.field,
      query.page,
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
  constructor(
    private readonly page: MyMemberPageService,
    private readonly editor: MemberPageEditorService,
  ) {}

  @Put('bio')
  @WriteThrottle()
  editBio(@Req() request: AuthenticatedRequest, @Body() body: EditTextDto) {
    return this.editor.editBio(getUserSub(request), body.text, body.baseSeq);
  }

  @Put('tabs/:tabId/text')
  @WriteThrottle()
  editTabText(
    @Req() request: AuthenticatedRequest,
    @Param('tabId') tabId: string,
    @Body() body: EditTextDto,
  ) {
    return this.editor.editTabText(
      getUserSub(request),
      tabId,
      body.text,
      body.baseSeq,
    );
  }

  @Put('tabs/:tabId/title')
  @WriteThrottle()
  editTabTitle(
    @Req() request: AuthenticatedRequest,
    @Param('tabId') tabId: string,
    @Body() body: EditTitleDto,
  ) {
    return this.editor.editTabTitle(
      getUserSub(request),
      tabId,
      body.title,
      body.baseSeq,
    );
  }

  @Patch('tabs/:tabId/position')
  @WriteThrottle()
  moveTab(
    @Req() request: AuthenticatedRequest,
    @Param('tabId') tabId: string,
    @Body() body: MoveTabDto,
  ) {
    return this.editor.moveTab(getUserSub(request), tabId, body.direction);
  }

  /** Off the page for everyone; the text and its history are kept. */
  @Delete('tabs/:tabId')
  @WriteThrottle()
  removeTab(
    @Req() request: AuthenticatedRequest,
    @Param('tabId') tabId: string,
  ) {
    return this.editor.removeTab(getUserSub(request), tabId);
  }

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

  /** Whether anonymous members may vote (Chunk 10; the screen is Chunk 12). */
  @Get('vote-eligibility')
  async voteEligibility() {
    return { anonymousMayVote: await this.settings.anonymousMayVote() };
  }

  @Put('vote-eligibility')
  @WriteThrottle()
  setVoteEligibility(
    @Req() request: AuthenticatedRequest,
    @Body() body: VoteEligibilityDto,
  ) {
    return this.settings.setAnonymousMayVote(
      body.anonymousMayVote,
      getUserSub(request),
    );
  }
}
