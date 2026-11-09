import { IsIn, IsString } from 'class-validator';
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

export class SetVotingInviteDto {
  /** A Telegram link, or empty to clear it. */
  @IsString()
  @Utf16Length(0, 300)
  inviteUrl: string;
}
