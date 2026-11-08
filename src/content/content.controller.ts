import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { getUserSub } from '../auth/auth.helpers';
import { Permissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { readSiteEnv } from '../config/site-env';
import { ContentService } from './content.service';
import { ExpectedDraftDto, SaveDraftDto } from './content.dto';
import type { PublishedWebsitePage } from './content.types';
import { withoutRealPayments } from './test-site-content';

@Controller('content/pages')
export class PublicContentController {
  constructor(
    private readonly content: ContentService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @Header('Cache-Control', 'public, no-cache')
  async list() {
    const pages = await this.content.listPublic();
    return pages.map((page) => this.forThisSite(page));
  }

  @Get(':pageId')
  @Header('Cache-Control', 'public, no-cache')
  async findOne(@Param('pageId') pageId: string) {
    return this.forThisSite(await this.content.getPublic(pageId));
  }

  /** The test site must never show ORG's real payment accounts. */
  private forThisSite(page: PublishedWebsitePage) {
    return readSiteEnv(this.config) === 'test'
      ? withoutRealPayments(page)
      : page;
  }
}

@Controller('admin/content/pages')
@UseGuards(ClerkAuthGuard, PermissionsGuard)
export class AdminContentController {
  constructor(private readonly content: ContentService) {}

  @Get()
  @Permissions('read:content')
  list() {
    return this.content.listAdmin();
  }

  @Get(':pageId')
  @Permissions('read:content')
  findOne(@Param('pageId') pageId: string) {
    return this.content.getAdmin(pageId);
  }

  @Put(':pageId/draft')
  @Permissions('update:content')
  saveDraft(
    @Req() request: AuthenticatedRequest,
    @Param('pageId') pageId: string,
    @Body() body: SaveDraftDto,
  ) {
    return this.content.saveDraft(
      pageId,
      body.expectedDraftRevision,
      body.content,
      getUserSub(request),
    );
  }

  @Post(':pageId/publish')
  @Permissions('publish:content')
  publish(
    @Req() request: AuthenticatedRequest,
    @Param('pageId') pageId: string,
    @Body() body: ExpectedDraftDto,
  ) {
    return this.content.publish(
      pageId,
      body.expectedDraftRevision,
      getUserSub(request),
    );
  }

  @Post(':pageId/discard-draft')
  @Permissions('update:content')
  discardDraft(
    @Param('pageId') pageId: string,
    @Body() body: ExpectedDraftDto,
  ) {
    return this.content.discardDraft(pageId, body.expectedDraftRevision);
  }

  @Post(':pageId/revisions/:revision/restore')
  @Permissions('update:content')
  restoreRevision(
    @Req() request: AuthenticatedRequest,
    @Param('pageId') pageId: string,
    @Param('revision', ParseIntPipe) revision: number,
    @Body() body: ExpectedDraftDto,
  ) {
    return this.content.restoreRevision(
      pageId,
      revision,
      body.expectedDraftRevision,
      getUserSub(request),
    );
  }
}
