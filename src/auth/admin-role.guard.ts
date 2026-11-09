import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AdminAccessService } from './admin-access.service';
import type { AuthenticatedRequest } from './auth.types';

/**
 * Only the real admin role (Clerk `publicMetadata.role`, read through
 * {@link AdminAccessService}). Token permission claims count for nothing, so
 * use this where a route must not be reachable by a claim.
 */
@Injectable()
export class AdminRoleGuard implements CanActivate {
  constructor(private readonly adminAccess: AdminAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (await this.adminAccess.hasAdminAccess(request)) return true;
    throw new ForbiddenException(
      'Your account does not have permission to perform this action.',
    );
  }
}
