import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { isOrgPageId } from './org-page-targets';
import { ORG_PAGE_NOT_FOUND } from './org-pages.service';

/**
 * Answers an id that is not one of ORG's pages with the same 404 for every
 * caller, before anything else about the request is read: sign-in, the
 * daily write ration, the query and the body (Chunk 10b round 2, N3).
 *
 * A guard rather than a pipe on `:pageId`, because guards run before any
 * pipe, so no body or query validation can answer first. A KNOWN page that
 * is not published passes here and is answered by the services: 404 for a
 * vote, a comment or a read, while withdrawing a vote still works.
 */
@Injectable()
export class OrgPageIdGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { pageId } = context.switchToHttp().getRequest<Request>().params;
    if (typeof pageId !== 'string' || !isOrgPageId(pageId)) {
      throw new NotFoundException(ORG_PAGE_NOT_FOUND);
    }
    return true;
  }
}
