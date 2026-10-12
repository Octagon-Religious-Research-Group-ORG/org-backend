import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsString,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { MAX_BLOCK_TEXT_LENGTH } from '../social/schemas/block-version.schema';
import {
  CONTACT_METHODS,
  type ContactMethod,
  PROFILE_VISIBILITIES,
  type ProfileVisibility,
} from '../social/schemas/social-profile.schema';

/** Most beliefs a new member can enter at once; more are added on the page. */
export const MAX_JOIN_BELIEFS = 20;

export class ContactEntryDto {
  @IsIn(CONTACT_METHODS)
  method: ContactMethod;

  @IsString()
  @Length(1, 200)
  value: string;
}

export class JoinBeliefDto {
  /** The tab label, e.g. "God" or "I. Basic Beliefs". */
  @IsString()
  @Length(1, 120)
  title: string;

  /** Paragraphs separated by a blank line. */
  @IsString()
  @Length(1, MAX_BLOCK_TEXT_LENGTH)
  text: string;
}

/**
 * Everything a new member submits to join the Members Community. Bio and at
 * least one belief are required (Tripp, D10: joining "requires the upload of
 * bio and beliefs"); so are two ways to reach them, the account email being
 * the first (plan §2d item 4).
 */
export class JoinMembershipDto {
  @IsString()
  @Length(1, 120)
  displayName: string;

  /** Page address, `orgspirituality.org/<slug>`. Lower-cased by the server. */
  @IsString()
  @Length(2, 80)
  slug: string;

  /** True when the display name is a nickname (anonymous membership). */
  @IsBoolean()
  anonymous: boolean;

  @IsIn(PROFILE_VISIBILITIES)
  visibility: ProfileVisibility;

  @IsString()
  @Length(1, MAX_BLOCK_TEXT_LENGTH)
  bio: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_JOIN_BELIEFS)
  @ValidateNested({ each: true })
  @Type(() => JoinBeliefDto)
  beliefs: JoinBeliefDto[];

  /** Shown on the page, only if the member adds them. */
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => ContactEntryDto)
  contacts: ContactEntryDto[];

  /** Admins only. At least one besides the account email. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => ContactEntryDto)
  backupContacts: ContactEntryDto[];

  /** The terms version the member read and agreed to. */
  @IsString()
  @MaxLength(40)
  termsVersion: string;
}
