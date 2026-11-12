import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { ClerkUserInfoService } from '../../auth/clerk-user-info.service';
import { MembersService } from '../members.service';
import type { Viewer } from '../profile-access';
import { describeFailure } from './comment-limits';

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

/**
 * Why a reader may not write, for the website to say so instead of showing
 * a form that would be refused.
 */
export type WriteBlock = 'sign-in' | 'needs-approved-page' | 'verify-email';

export interface WriteStatus {
  mayComment: boolean;
  block?: WriteBlock;
}

function isMember(viewer: Viewer) {
  return viewer.kind === 'anonymous-member' || viewer.kind === 'named-member';
}

/**
 * Who may write a comment or a suggestion (Chunk 9): a signed-in account with
 * a verified email AND an approved member page (any kind, anonymous too), or
 * an admin. Guests, accounts with no page and accounts whose page is pending
 * may not. The page and the role come from the database and Clerk only.
 */
@Injectable()
export class CommentWritersService {
  private readonly logger = new Logger(CommentWritersService.name);

  constructor(
    private readonly members: MembersService,
    private readonly clerk: ClerkUserInfoService,
  ) {}

  /**
   * The same rule as {@link requireWriter}, as an answer for a page read.
   * If Clerk cannot be asked, a member is offered the form: the write itself
   * checks again and says why it is refused.
   */
  async writeStatus(viewer: Viewer): Promise<WriteStatus> {
    if (viewer.userId === undefined) {
      return { mayComment: false, block: 'sign-in' };
    }
    if (viewer.isAdmin) return { mayComment: true };
    if (!isMember(viewer)) {
      return { mayComment: false, block: 'needs-approved-page' };
    }
    try {
      const identity = await this.clerk.getIdentity(viewer.userId);
      if (!identity.email || !identity.emailVerified) {
        return { mayComment: false, block: 'verify-email' };
      }
    } catch (error) {
      this.logger.warn(
        `Could not read an email status: ${describeFailure(error)}`,
      );
    }
    return { mayComment: true };
  }

  /**
   * @throws ForbiddenException with the reason, for anyone else
   */
  async requireWriter(request: AuthenticatedRequest): Promise<CommentWriter> {
    const viewer = await this.members.resolveViewer(request);
    const userId = viewer.userId;
    if (userId === undefined) throw new ForbiddenException(NEEDS_APPROVED_PAGE);
    const member = isMember(viewer);
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
