import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import type { Response } from 'express';
import { type Receipt, receiptZip } from '../../anchoring/receipt';
import { OptionalClerkAuthGuard } from '../../auth/auth.guard';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { MembersService } from '../members.service';
import {
  MemberJsonCacheInterceptor,
  NoStoreWhenSignedInInterceptor,
} from '../no-store.interceptor';
import { OrgPageIdGuard } from '../org-pages/org-page-id.guard';
import { BeliefReceiptQueryDto, ReceiptQueryDto } from './receipts.dto';
import { ReceiptsService } from './receipts.service';

/** Each receipt re-checks its proofs: rationed per visitor. */
export const RECEIPT_THROTTLE = { ttl: seconds(60), limit: 20 };

/** A file name with nothing a header or a file system could misread. */
export function receiptFileName(...parts: Array<string | number>): string {
  return `receipt-${parts.map((part) => String(part).replace(/[^A-Za-z0-9_-]/g, '-')).join('-')}.zip`;
}

function sendZip(response: Response, receipt: Receipt, name: string) {
  response.setHeader('Content-Type', 'application/zip');
  response.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  response.send(Buffer.from(receiptZip(receipt)));
}

/**
 * Receipts (Chunk 16): the JSON, and the same as a zip with every file the
 * public tools read. Exactly who may read the history may have one; anyone
 * else gets the history's own 404.
 */
@Controller('members')
@UseGuards(OptionalClerkAuthGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor, MemberJsonCacheInterceptor)
@Throttle({ default: RECEIPT_THROTTLE })
export class ReceiptsController {
  constructor(
    private readonly members: MembersService,
    private readonly receipts: ReceiptsService,
  ) {}

  private async belief(
    request: AuthenticatedRequest,
    slug: string,
    tabId: string,
    query: BeliefReceiptQueryDto,
  ) {
    return this.receipts.belief(
      slug,
      tabId,
      await this.members.resolveViewer(request),
      query.field,
      query.seq,
    );
  }

  @Get('profiles/:slug/tabs/:tabId/receipt')
  beliefReceipt(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Param('tabId') tabId: string,
    @Query() query: BeliefReceiptQueryDto,
  ) {
    return this.belief(request, slug, tabId, query);
  }

  @Get('profiles/:slug/tabs/:tabId/receipt/download')
  async beliefReceiptZip(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
    @Param('slug') slug: string,
    @Param('tabId') tabId: string,
    @Query() query: BeliefReceiptQueryDto,
  ) {
    const receipt = await this.belief(request, slug, tabId, query);
    sendZip(
      response,
      receipt,
      receiptFileName(
        slug,
        tabId,
        query.field ?? 'text',
        receipt.versions[0].seq,
      ),
    );
  }

  private async comment(
    request: AuthenticatedRequest,
    slug: string,
    commentId: string,
    query: ReceiptQueryDto,
  ) {
    return this.receipts.comment(
      slug,
      commentId,
      await this.members.resolveViewer(request),
      query.seq,
    );
  }

  @Get('profiles/:slug/comments/:commentId/receipt')
  commentReceipt(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Param('commentId') commentId: string,
    @Query() query: ReceiptQueryDto,
  ) {
    return this.comment(request, slug, commentId, query);
  }

  @Get('profiles/:slug/comments/:commentId/receipt/download')
  async commentReceiptZip(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
    @Param('slug') slug: string,
    @Param('commentId') commentId: string,
    @Query() query: ReceiptQueryDto,
  ) {
    const receipt = await this.comment(request, slug, commentId, query);
    sendZip(
      response,
      receipt,
      receiptFileName(slug, commentId, receipt.versions[0].seq),
    );
  }
}

/** The same for comments on ORG's own pages; the page id is checked first. */
@Controller('members/org-pages/:pageId')
@UseGuards(OrgPageIdGuard, OptionalClerkAuthGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor, MemberJsonCacheInterceptor)
@Throttle({ default: RECEIPT_THROTTLE })
export class OrgPageReceiptsController {
  constructor(
    private readonly members: MembersService,
    private readonly receipts: ReceiptsService,
  ) {}

  private async receipt(
    request: AuthenticatedRequest,
    pageId: string,
    commentId: string,
    query: ReceiptQueryDto,
  ) {
    return this.receipts.orgComment(
      pageId,
      commentId,
      await this.members.resolveViewer(request),
      query.seq,
    );
  }

  @Get('comments/:commentId/receipt')
  commentReceipt(
    @Req() request: AuthenticatedRequest,
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Query() query: ReceiptQueryDto,
  ) {
    return this.receipt(request, pageId, commentId, query);
  }

  @Get('comments/:commentId/receipt/download')
  async commentReceiptZip(
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
    @Param('pageId') pageId: string,
    @Param('commentId') commentId: string,
    @Query() query: ReceiptQueryDto,
  ) {
    const receipt = await this.receipt(request, pageId, commentId, query);
    sendZip(
      response,
      receipt,
      receiptFileName(pageId, commentId, receipt.versions[0].seq),
    );
  }
}
