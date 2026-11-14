import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminRoleGuard } from '../auth/admin-role.guard';
import { ClerkAuthGuard, OptionalClerkAuthGuard } from '../auth/auth.guard';
import { getUserSub } from '../auth/auth.helpers';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { SEARCH_THROTTLE, WriteThrottle } from '../config/throttle';
import { MembersService } from '../members/members.service';
import {
  MemberJsonCacheInterceptor,
  NoStoreWhenSignedInInterceptor,
} from '../members/no-store.interceptor';
import { SearchQueryDto, SetFragmentHiddenDto } from './search.dto';
import { SearchFragmentsService } from './search-fragments.service';
import { SearchService } from './search.service';
import { MIN_QUERY_LENGTH, normaliseQuery } from './search-text';

/**
 * Public search (Chunk 15). Who is asking comes only from the verified token;
 * a guest gets what a guest may see. Answers depend on the reader, so they are
 * stored nowhere (`no-store`, `Vary: Origin, Authorization`).
 */
@Controller('search')
@UseGuards(OptionalClerkAuthGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor, MemberJsonCacheInterceptor)
export class SearchController {
  constructor(
    private readonly members: MembersService,
    private readonly search: SearchService,
    private readonly fragments: SearchFragmentsService,
  ) {}

  @Get()
  @Throttle({ default: SEARCH_THROTTLE })
  async find(
    @Req() request: AuthenticatedRequest,
    @Query() query: SearchQueryDto,
  ) {
    const q = normaliseQuery(query.q);
    const type = query.type ?? 'all';
    const page = query.page ?? 1;
    if (q.length < MIN_QUERY_LENGTH) return this.search.empty(q, type, page);
    const viewer = await this.members.resolveViewer(request);
    const response = await this.search.search(q, type, page, viewer);
    if (page === 1) {
      // Counted after answering and never awaited by the reader. The
      // visitor key is never stored: only HMACs of it under a key derived
      // from the server secret (fragment-keys.ts).
      void this.fragments.record(
        q,
        response.total,
        viewer.userId ? `user:${viewer.userId}` : `ip:${request.ip}`,
      );
    }
    return response;
  }

  /** The Perforated Index's Suggested Fragments. */
  @Get('fragments')
  async suggested() {
    return { fragments: await this.fragments.fragments() };
  }
}

/** Hiding a Suggested Fragment (Chunk 15): admins only, logged. */
@Controller('admin/search-fragments')
@UseGuards(ClerkAuthGuard, AdminRoleGuard)
@UseInterceptors(NoStoreWhenSignedInInterceptor)
export class AdminSearchFragmentsController {
  constructor(private readonly fragments: SearchFragmentsService) {}

  @Get()
  async list() {
    return { fragments: await this.fragments.adminView() };
  }

  @Post()
  @WriteThrottle()
  setHidden(
    @Req() request: AuthenticatedRequest,
    @Body() body: SetFragmentHiddenDto,
  ) {
    return this.fragments.setHidden(
      body.term,
      body.hidden,
      getUserSub(request),
      body.reason,
    );
  }
}
