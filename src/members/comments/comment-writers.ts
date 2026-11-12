import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { ClerkUserInfoService } from '../../auth/clerk-user-info.service';
import { MembersService } from '../members.service';
import type { Viewer } from '../profile-access';

export const NEEDS_APPROVED_PAGE =
  'Comments and suggestions are open to members whose page has been approved.';
export const NEEDS_VERIFIED_EMAIL =
  'Please confirm your email address before commenting.';

/** A viewer allowed to write comments, with their id for sure. */
export interface CommentWriter extends Viewer {
  userId: string;
  /** An admin writing without an approved page of their own. */
  writesAsAdmin: boolean;
}

/** May this viewer see the comment form at all (no email check here). */
export function mayOfferCommentForm(viewer: Viewer): boolean {
  return (
    viewer.isAdmin ||
    viewer.kind === 'anonymous-member' ||
    viewer.kind === 'named-member'
  );
}

/**
 * Who may write a comment or a suggestion (Chunk 9): a signed-in account with
 * a verified email AND an approved member page (any kind, anonymous too), or
 * an admin. Guests, accounts with no page and accounts whose page is pending
 * may not. The page and the role come from the database and Clerk only.
 */
@Injectable()
export class CommentWritersService {
  constructor(
    private readonly members: MembersService,
    private readonly clerk: ClerkUserInfoService,
  ) {}

  /**
   * @throws ForbiddenException with the reason, for anyone else
   */
  async requireWriter(request: AuthenticatedRequest): Promise<CommentWriter> {
    const viewer = await this.members.resolveViewer(request);
    const userId = viewer.userId;
    if (userId === undefined) throw new ForbiddenException(NEEDS_APPROVED_PAGE);
    const member =
      viewer.kind === 'anonymous-member' || viewer.kind === 'named-member';
    if (viewer.isAdmin) {
      return { ...viewer, userId, writesAsAdmin: !member };
    }
    if (!member) throw new ForbiddenException(NEEDS_APPROVED_PAGE);
    const identity = await this.clerk.getIdentity(userId);
    if (!identity.email || !identity.emailVerified) {
      throw new ForbiddenException(NEEDS_VERIFIED_EMAIL);
    }
    return { ...viewer, userId, writesAsAdmin: false };
  }
}
