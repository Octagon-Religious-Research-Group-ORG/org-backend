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
import { ClerkAuthGuard } from '../auth/auth.guard';
import { getUserSub } from '../auth/auth.helpers';
import { Permissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ContentService } from './content.service';
import { ExpectedDraftDto, SaveDraftDto } from './content.dto';

@Controller('content/pages')
export class PublicContentController {
  constructor(private readonly content: ContentService) {}

  @Get()
  @Header('Cache-Control', 'public, no-cache')
  list() {
    return this.content.listPublic();
  }

  @Get(':pageId')
  @Header('Cache-Control', 'public, no-cache')
  findOne(@Param('pageId') pageId: string) {
    return this.content.getPublic(pageId);
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
