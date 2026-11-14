import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { AuthenticatedRequest } from '../auth/auth.types';
import {
  AccountDeletion,
  type AccountDeletionDocument,
} from '../member-data/schemas/account-deletion.schema';

export const ACCOUNT_DELETED_WRITE =
  'This account was deleted, so it can no longer write here.';

/**
 * Refuses member writes (comments, suggestions, votes, claims) from an
 * account whose deletion is recorded (Chunk 17 review round 5, LOW-1): the
 * webhook froze the list of what it had written when it recorded the
 * deletion, so nothing may be added after. A Clerk session token can stay
 * valid for a few minutes after the account is deleted. Runs after
 * `ClerkAuthGuard`, which sets the subject; without one it refuses.
 */
@Injectable()
export class AccountNotDeletedGuard implements CanActivate {
  constructor(
    @InjectModel(AccountDeletion.name)
    private readonly accountModel: Model<AccountDeletionDocument>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.auth?.payload.sub;
    if (!userId || (await this.accountModel.exists({ userId }).exec())) {
      throw new ForbiddenException(ACCOUNT_DELETED_WRITE);
    }
    return true;
  }
}
