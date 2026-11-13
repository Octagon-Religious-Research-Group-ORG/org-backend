import {
  IsBoolean,
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
import { ID_PATTERN } from '../comments/comments.dto';
import { MAX_CLIENT_SEQ } from '../members.dto';
import { AGREED_CURSOR } from './votes.service';

/** A page address may be typed in any case; the service lowercases it. */
const SLUG_INPUT = /^[A-Za-z0-9-]{1,80}$/;

export class CastVoteDto {
  @IsString()
  @Matches(SLUG_INPUT)
  slug: string;

  @IsString()
  @Matches(ID_PATTERN)
  tabId: string;

  @IsIn(VOTE_VALUES)
  value: VoteValue;

  /** The belief text's version the voter was looking at (`textSeq`). */
  @IsInt()
  @Min(0)
  @Max(MAX_CLIENT_SEQ)
  baseSeq: number;
}

export class WithdrawVoteDto {
  @IsString()
  @Matches(SLUG_INPUT)
  slug: string;

  @IsString()
  @Matches(ID_PATTERN)
  tabId: string;
}

export class AgreedQueryDto {
  /** `nextAfter` of the previous page. */
  @IsOptional()
  @IsString()
  @Matches(AGREED_CURSOR)
  after?: string;
}

export class VoteEligibilityDto {
  @IsBoolean()
  anonymousMayVote: boolean;
}
