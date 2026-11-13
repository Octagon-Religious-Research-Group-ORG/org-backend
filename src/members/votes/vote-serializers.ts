import type { VoteValue } from '../../social/schemas/belief-vote.schema';
import type { ParagraphView } from '../profile-serializers';
import type { WriteBlock } from '../comments/comment-writers';
import type { VoteBlock } from './voters.service';

/**
 * Allowlist shapes for votes (Chunk 10): every field written out by name.
 * Voter ids, tiers, history and other voters' choices never leave the server;
 * a reader sees counts and their own vote only.
 */

/** One belief's votes, as one reader sees them. */
export interface TabVotes {
  /** Counted agrees on the current wording. */
  agree: number;
  disagree: number;
  /** Votes kept from an earlier wording; not counted. */
  earlierWording: number;
  /** The reader's vote on the current wording. */
  myVote?: VoteValue;
  /** The reader's vote on an earlier wording, to confirm on this one. */
  myVoteOnEarlierWording?: VoteValue;
  /** The buttons work for this reader on this belief. */
  mayVote: boolean;
  /** Why not, when not. */
  viewerVoteBlock?: VoteBlock;
}

/** One entry of the Beliefs page section. */
export interface AgreedBelief {
  slug: string;
  tabId: string;
  title: string;
  paragraphs: ParagraphView[];
  /** What a vote from the list is based on. */
  textSeq: number;
  /**
   * The member, named per the Chunk 9 rule; the list holds only pages the
   * reader may read in full, so the link is always theirs to follow.
   */
  author: { displayName: string; slug: string };
  votes: TabVotes;
}

export interface AgreedPage {
  beliefs: AgreedBelief[];
  /** Pass as `after` for the next page; absent on the last one. */
  nextAfter?: string;
  /**
   * The reader may comment on the listed beliefs (Chunk 9's rule; every
   * listed page is one they may read in full), and why not when not.
   */
  viewerMayComment: boolean;
  viewerWriteBlock?: WriteBlock;
}
