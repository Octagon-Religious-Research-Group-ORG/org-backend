import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { Utf16Length } from '../../membership/utf16-length';
import {
  CLAIM_STATUSES,
  type ClaimStatus,
  MAX_CLAIM_MESSAGE_LENGTH,
  MAX_CLAIM_REASON_LENGTH,
} from '../../social/schemas/claim.schema';
import { ID_PATTERN } from '../comments/comments.dto';

/** A page address may be typed in any case; the service lowercases it. */
const SLUG_INPUT = /^[A-Za-z0-9-]{1,80}$/;

/**
 * Longest message a client may SEND: above what is stored, because cleaning
 * removes control characters first; the service then refuses a cleaned text
 * over the limit with a specific message.
 */
export const MAX_CLAIM_MESSAGE_INPUT = 3 * MAX_CLAIM_MESSAGE_LENGTH;
export const MAX_CLAIM_REASON_INPUT = 3 * MAX_CLAIM_REASON_LENGTH;

/** Comments one link or unlink may name. */
export const MAX_LINKED_PER_REQUEST = 100;

export class NewClaimDto {
  @IsString()
  @Matches(SLUG_INPUT)
  slug: string;

  /** How the admins can tell the page is theirs. */
  @IsString()
  @Utf16Length(1, MAX_CLAIM_MESSAGE_INPUT)
  message: string;
}

export class RejectClaimDto {
  /** Shown to the person who asked. */
  @IsOptional()
  @IsString()
  @Utf16Length(0, MAX_CLAIM_REASON_INPUT)
  reason?: string;
}

export class ClaimListQueryDto {
  @IsOptional()
  @IsIn(CLAIM_STATUSES)
  status?: ClaimStatus;
}

export class LinkCommentsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINKED_PER_REQUEST)
  @IsString({ each: true })
  @Matches(ID_PATTERN, { each: true })
  commentIds: string[];
}
