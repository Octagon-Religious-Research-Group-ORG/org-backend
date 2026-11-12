import {
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  MAX_REMEMBERED_READ_ANSWERS,
  ROLE_CACHE_MAX_AGE_MS,
} from '../../auth/admin-access.service';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { ClerkUserInfoService } from '../../auth/clerk-user-info.service';
import { MembersService } from '../members.service';
import type { Viewer } from '../profile-access';
import { describeFailure } from './comment-limits';

export const NEEDS_APPROVED_PAGE =
  'Comments and suggestions are open to members whose page has been approved.';
export const NEEDS_VERIFIED_EMAIL =
  'Please confirm your email address before commenting.';
export const CANNOT_CHECK_ACCOUNT =
  "We can't check your account right now. Please try again in a moment.";

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
export type WriteBlock =
  | 'sign-in'
  | 'needs-approved-page'
  | 'verify-email'
  | 'cannot-check';

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
 *
 * Whether an account's email is verified is remembered for
 * {@link ROLE_CACHE_MAX_AGE_MS}, at most {@link MAX_REMEMBERED_READ_ANSWERS}
 * accounts, like the admin role (review round 2, item 3): every thread read
 * of a signed-in member would otherwise ask Clerk. Only a VERIFIED answer is
 * remembered (review round 3): an unverified one is asked again every time,
 * so a member who has just confirmed their email can write at once. A
 * failed lookup is never remembered either.
 */
@Injectable()
export class CommentWritersService {
  private readonly logger = new Logger(CommentWritersService.name);
  /** Accounts whose email Clerk said is verified, until when. */
  private readonly verified = new Map<string, number>();

  constructor(
    private readonly members: MembersService,
    private readonly clerk: ClerkUserInfoService,
  ) {}

  /** @throws whatever the Clerk lookup throws; nothing is remembered then */
  private async emailVerified(userId: string): Promise<boolean> {
    const until = this.verified.get(userId);
    if (until !== undefined && Date.now() < until) return true;
    const identity = await this.clerk.getIdentity(userId);
    const verified = Boolean(identity.email) && identity.emailVerified;
    this.verified.delete(userId);
    if (!verified) return false;
    if (this.verified.size >= MAX_REMEMBERED_READ_ANSWERS) {
      const [oldest] = this.verified.keys();
      this.verified.delete(oldest);
    }
    this.verified.set(userId, Date.now() + ROLE_CACHE_MAX_AGE_MS);
    return true;
  }

  /**
   * The same rule as {@link requireWriter}, as an answer for a page read.
   * When Clerk cannot be asked, the reader is told so (`cannot-check`)
   * instead of being shown a form the write would refuse.
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
      return (await this.emailVerified(viewer.userId))
        ? { mayComment: true }
        : { mayComment: false, block: 'verify-email' };
    } catch (error) {
      this.logger.warn(
        `Could not read an email status: ${describeFailure(error)}`,
      );
      return { mayComment: false, block: 'cannot-check' };
    }
  }

  /**
   * @throws ForbiddenException with the reason, for anyone else
   * @throws ServiceUnavailableException when the account cannot be checked
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
    let verified: boolean;
    try {
      verified = await this.emailVerified(userId);
    } catch (error) {
      // A rejected account (Clerk's 404) stays what it is; anything else is
      // "try again", never a server error.
      if (error instanceof HttpException && error.getStatus() === 401) {
        throw error;
      }
      this.logger.warn(
        `Could not check a writer's email: ${describeFailure(error)}`,
      );
      throw new ServiceUnavailableException(CANNOT_CHECK_ACCOUNT);
    }
    if (!verified) throw new ForbiddenException(NEEDS_VERIFIED_EMAIL);
    return { ...viewer, userId, writesAsAdmin: false };
  }
}
