import {
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { VoterTier } from '../../social/schemas/belief-vote.schema';
import { describeFailure } from '../comments/comment-limits';
import {
  CANNOT_CHECK_ACCOUNT,
  CommentWritersService,
  type WriteStatus,
} from '../comments/comment-writers';
import type { Viewer } from '../profile-access';

export const SIGN_IN_TO_VOTE = 'Please sign in to vote.';
export const NEEDS_APPROVED_PAGE_TO_VOTE =
  'Votes are open to members whose page has been approved.';
export const ANONYMOUS_VOTING_OFF =
  'Anonymous members cannot vote for now. The members will decide whether they can.';
export const VERIFY_EMAIL_TO_VOTE =
  'Please confirm your email address before voting.';
export const OWN_BELIEF = 'You cannot vote on your own beliefs.';
export const PAGE_NOT_OPEN = 'Voting opens once this page is approved.';

/**
 * Why a reader may not vote, for the website to say so on disabled buttons
 * instead of offering a vote that would be refused.
 */
export type VoteBlock =
  | 'sign-in'
  | 'needs-approved-page'
  | 'anonymous-off'
  | 'verify-email'
  | 'cannot-check'
  | 'own-belief'
  | 'not-open';

export interface VoteStatus {
  mayVote: boolean;
  block?: VoteBlock;
}

/** A viewer allowed to vote, with their id and the tier their vote counts in. */
export interface Voter extends Viewer {
  userId: string;
  tier: VoterTier;
}

/** What a page adds to the rule: whose it is, and whether it is approved. */
export interface VotePage {
  isOwner: boolean;
  approved: boolean;
}

/**
 * Who may vote (Chunk 10). The same rule as commenting (Chunk 9: a verified
 * email AND an approved page of one's own), except:
 * - an admin without an approved page of their own may NOT vote: votes are
 *   member votes;
 * - a member whose page is anonymous may vote only while the admin setting
 *   `anonymousMayVote` is on (default off, plan §2b item 5);
 * - nobody votes on their own beliefs, and nobody on a page not yet approved.
 *
 * Unclaimed imported pages have no owner, so anyone else allowed may vote on
 * them: voting is not an owner action.
 */
@Injectable()
export class VotersService {
  private readonly logger = new Logger(VotersService.name);

  constructor(private readonly writers: CommentWritersService) {}

  /** Whether this reader may comment (Chunk 9's rule), and why not. */
  commentStatus(viewer: Viewer): Promise<WriteStatus> {
    return this.writers.writeStatus(viewer);
  }

  /**
   * The rule for this reader, before any page. Asks Clerk (cached) only for
   * a member who could otherwise vote.
   */
  async status(viewer: Viewer, anonymousMayVote: boolean): Promise<VoteStatus> {
    const early = this.beforeEmail(viewer, anonymousMayVote);
    if (early) return { mayVote: false, block: early };
    try {
      return (await this.writers.emailVerified(String(viewer.userId)))
        ? { mayVote: true }
        : { mayVote: false, block: 'verify-email' };
    } catch (error) {
      this.logger.warn(
        `Could not read an email status: ${describeFailure(error)}`,
      );
      return { mayVote: false, block: 'cannot-check' };
    }
  }

  /** The reader's status on one page; a page reason wins over the email. */
  onPage(status: VoteStatus, page: VotePage): VoteStatus {
    if (status.block === 'sign-in' || status.block === 'needs-approved-page') {
      return status;
    }
    if (page.isOwner) return { mayVote: false, block: 'own-belief' };
    if (!page.approved) return { mayVote: false, block: 'not-open' };
    return status;
  }

  /**
   * @throws ForbiddenException with the reason, for anyone else
   * @throws ServiceUnavailableException when the account cannot be checked
   */
  async requireVoter(viewer: Viewer, anonymousMayVote: boolean) {
    const early = this.beforeEmail(viewer, anonymousMayVote);
    if (early) throw new ForbiddenException(BLOCK_MESSAGES[early]);
    const userId = String(viewer.userId);
    let verified: boolean;
    try {
      verified = await this.writers.emailVerified(userId);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 401) {
        throw error;
      }
      this.logger.warn(
        `Could not check a voter's email: ${describeFailure(error)}`,
      );
      throw new ServiceUnavailableException(CANNOT_CHECK_ACCOUNT);
    }
    if (!verified) throw new ForbiddenException(VERIFY_EMAIL_TO_VOTE);
    const voter: Voter = {
      ...viewer,
      userId,
      tier: viewer.kind === 'anonymous-member' ? 'anonymous' : 'member',
    };
    return voter;
  }

  /** @throws ForbiddenException when the page itself refuses the vote */
  requireOnPage(page: VotePage) {
    const status = this.onPage({ mayVote: true }, page);
    if (status.block)
      throw new ForbiddenException(BLOCK_MESSAGES[status.block]);
  }

  private beforeEmail(
    viewer: Viewer,
    anonymousMayVote: boolean,
  ): VoteBlock | undefined {
    if (viewer.userId === undefined) return 'sign-in';
    if (viewer.kind === 'anonymous-member') {
      return anonymousMayVote ? undefined : 'anonymous-off';
    }
    // Admins included: only a member's own approved page gives a vote.
    return viewer.kind === 'named-member' ? undefined : 'needs-approved-page';
  }
}

/** What a refused vote is told, by reason. */
export const BLOCK_MESSAGES: Record<VoteBlock, string> = {
  'sign-in': SIGN_IN_TO_VOTE,
  'needs-approved-page': NEEDS_APPROVED_PAGE_TO_VOTE,
  'anonymous-off': ANONYMOUS_VOTING_OFF,
  'verify-email': VERIFY_EMAIL_TO_VOTE,
  'cannot-check': CANNOT_CHECK_ACCOUNT,
  'own-belief': OWN_BELIEF,
  'not-open': PAGE_NOT_OPEN,
};
