import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  VOTE_VALUES,
  type VoteValue,
} from '../../social/schemas/belief-vote.schema';
import { Utf16Length } from '../../membership/utf16-length';
import { ID_PATTERN, MAX_COMMENT_INPUT } from '../comments/comments.dto';
import { MAX_CLIENT_SEQ } from '../members.dto';

/** A vote on one of ORG's own pages (Chunk 10b); the page is in the path. */
export class OrgPageVoteDto {
  @IsIn(VOTE_VALUES)
  value: VoteValue;

  /** The page's published revision the voter was looking at. */
  @IsInt()
  @Min(1)
  @Max(MAX_CLIENT_SEQ)
  baseSeq: number;
}

/** A comment on one of ORG's own pages; it has one thread, so no tab. */
export class NewOrgPageCommentDto {
  /** The comment answered; a reply to a reply joins its top-level comment. */
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN)
  parentCommentId?: string;

  @IsString()
  @Utf16Length(1, MAX_COMMENT_INPUT)
  body: string;

  /** "Agree and comment" / "Disagree and comment": the writer's vote. */
  @IsOptional()
  @IsIn(VOTE_VALUES)
  stance?: VoteValue;
}

export class OrgThreadQueryDto {
  /** `nextAfter` of the previous page. */
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN)
  after?: string;
}
