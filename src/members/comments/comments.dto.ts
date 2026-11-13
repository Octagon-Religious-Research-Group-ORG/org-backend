import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { MAX_COMMENT_LENGTH } from '../../social/schemas/comment.schema';
import {
  VOTE_VALUES,
  type VoteValue,
} from '../../social/schemas/belief-vote.schema';
import { Utf16Length } from '../../membership/utf16-length';
import {
  MAX_CLIENT_SEQ,
  MAX_EDIT_TEXT_INPUT,
  MAX_HISTORY_PAGE,
} from '../members.dto';

/** Tab, comment and page ids, as this site writes them. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
/** A page address may be typed in any case; the service lowercases it. */
const SLUG_INPUT = /^[A-Za-z0-9-]{1,80}$/;

/**
 * Longest comment a client may SEND: above what is stored, because cleaning
 * removes control characters first; the service then refuses a cleaned text
 * over {@link MAX_COMMENT_LENGTH} with a specific message.
 */
export const MAX_COMMENT_INPUT = 3 * MAX_COMMENT_LENGTH;

/** Longest note a suggestion may send. */
export const MAX_NOTE_INPUT = MAX_COMMENT_LENGTH;

/**
 * Body limit for the suggestion route: the whole proposed text and a note in
 * the worst JSON encoding (six bytes per UTF-16 unit), plus the other fields.
 */
export const MAX_SUGGESTION_BODY_BYTES =
  6 * (MAX_EDIT_TEXT_INPUT + MAX_NOTE_INPUT) + 1024;

export class ThreadQueryDto {
  /** A belief tab; absent for the page's own thread ("About this page"). */
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN)
  tab?: string;

  /** `nextAfter` of the previous page. */
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN)
  after?: string;
}

export class CommentHistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_HISTORY_PAGE)
  page?: number;
}

export class NewCommentDto {
  @IsString()
  @Matches(SLUG_INPUT)
  slug: string;

  /** The belief's thread; absent for "About this page". */
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN)
  tabId?: string;

  /** The comment answered; a reply to a reply joins its top-level comment. */
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN)
  parentCommentId?: string;

  @IsString()
  @Utf16Length(1, MAX_COMMENT_INPUT)
  body: string;

  /**
   * "Agree and comment" / "Disagree and comment" (Chunk 10): the writer's
   * vote on this belief, which they cast first.
   */
  @IsOptional()
  @IsIn(VOTE_VALUES)
  stance?: VoteValue;
}

export class EditCommentDto {
  @IsString()
  @Utf16Length(1, MAX_COMMENT_INPUT)
  body: string;

  /** The comment's `seq` as the page showed it. */
  @IsInt()
  @Min(1)
  @Max(MAX_CLIENT_SEQ)
  baseSeq: number;
}

export class NewSuggestionDto {
  @IsString()
  @Matches(SLUG_INPUT)
  slug: string;

  @IsString()
  @Matches(ID_PATTERN)
  tabId: string;

  /** The whole proposed text of the belief; paragraphs by blank lines. */
  @IsString()
  @Utf16Length(1, MAX_EDIT_TEXT_INPUT)
  text: string;

  /** The belief text's version the member was looking at (`textSeq`). */
  @IsInt()
  @Min(0)
  @Max(MAX_CLIENT_SEQ)
  baseSeq: number;

  @IsOptional()
  @IsString()
  @Utf16Length(0, MAX_NOTE_INPUT)
  note?: string;
}
