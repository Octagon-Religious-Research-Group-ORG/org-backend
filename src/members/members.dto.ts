import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { MAX_TAB_TITLE_LENGTH } from '../social/schemas/belief-tab.schema';
import { MAX_BLOCK_TEXT_LENGTH } from '../social/schemas/block-version.schema';
import {
  PROFILE_VISIBILITIES,
  type ProfileVisibility,
} from '../social/schemas/social-profile.schema';
import { Utf16Length } from '../membership/utf16-length';

export class ChangeVisibilityDto {
  @IsIn(PROFILE_VISIBILITIES)
  visibility: ProfileVisibility;
}

export class AddBeliefTabDto {
  @IsString()
  @Utf16Length(1, MAX_TAB_TITLE_LENGTH)
  title: string;

  /** Paragraphs separated by a blank line. */
  @IsString()
  @Utf16Length(1, MAX_BLOCK_TEXT_LENGTH)
  text: string;
}

/** Upper bound for a version number a client may send; far above any real one. */
export const MAX_CLIENT_SEQ = 1_000_000;

/** A changed bio or belief text, and the version the editor started from. */
/**
 * Longest text an edit may SEND. Above what one version holds, on purpose: an
 * imported belief can be longer, and saving it unchanged must not fail. The
 * service refuses a CHANGED text over one version with a specific message.
 */
export const MAX_EDIT_TEXT_INPUT = 60_000;

export class EditTextDto {
  /** Paragraphs separated by a blank line. */
  @IsString()
  @Utf16Length(1, MAX_EDIT_TEXT_INPUT)
  text: string;

  /** The `revisions` number the page showed; 0 when it had none. */
  @IsInt()
  @Min(0)
  @Max(MAX_CLIENT_SEQ)
  baseSeq: number;
}

export class EditTitleDto {
  @IsString()
  @Utf16Length(1, MAX_TAB_TITLE_LENGTH)
  title: string;

  @IsInt()
  @Min(0)
  @Max(MAX_CLIENT_SEQ)
  baseSeq: number;
}

export const TAB_MOVES = ['up', 'down'] as const;
export type TabMove = (typeof TAB_MOVES)[number];

export class MoveTabDto {
  /** `up` is earlier on the page, `down` later. */
  @IsIn(TAB_MOVES)
  direction: TabMove;
}

/** Most history pages a client may ask for; 20 versions each. */
export const MAX_HISTORY_PAGE = 5_000;

export class HistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_HISTORY_PAGE)
  page?: number;
}

export const TAB_HISTORY_FIELDS = ['text', 'title'] as const;
export type TabHistoryField = (typeof TAB_HISTORY_FIELDS)[number];

export class TabHistoryQueryDto extends HistoryQueryDto {
  @IsOptional()
  @IsIn(TAB_HISTORY_FIELDS)
  field?: TabHistoryField;
}

export class SetVotingInviteDto {
  /** A Telegram link, or empty to clear it. */
  @IsString()
  @Utf16Length(0, 300)
  inviteUrl: string;
}
