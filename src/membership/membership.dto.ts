import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsString,
  ValidateNested,
} from 'class-validator';
import { MAX_BLOCK_TEXT_LENGTH } from '../social/schemas/block-version.schema';
import { MAX_TAB_TITLE_LENGTH } from '../social/schemas/belief-tab.schema';
import {
  CONTACT_METHODS,
  type ContactMethod,
  MAX_CONTACT_VALUE_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  PROFILE_VISIBILITIES,
  type ProfileVisibility,
} from '../social/schemas/social-profile.schema';
import { Utf16Length } from './utf16-length';

/** Most beliefs a new member can enter at once; more are added on the page. */
export const MAX_JOIN_BELIEFS = 20;

/**
 * Most paragraphs one join may create, bio and beliefs together. Each paragraph
 * becomes permanent append-only rows, so the count is bounded separately from
 * the text: one short bio of blank-line-separated letters created thousands.
 */
export const MAX_JOIN_PARAGRAPHS = 200;

/**
 * Most characters of bio and belief text one join may hold in total. Each box
 * has its own limit (MAX_BLOCK_TEXT_LENGTH); this caps them added up, so that
 * everything the form allows also fits the request body limit below.
 */
export const MAX_JOIN_TEXT_CHARS = 200_000;

const MAX_SLUG = 80;
const MAX_CONTACT_ROWS = 5;
const MAX_TERMS_VERSION = 40;

/** Generous allowance for JSON keys, quotes and brackets of a full request. */
const JSON_STRUCTURE_BYTES = 4096;

/**
 * Request body limit of the join route, derived from the limits above so they
 * cannot drift apart. Three bytes per character is the UTF-8 worst case for
 * typed text (an emoji is two characters and four bytes; a line break is
 * written as two bytes in JSON).
 */
export const MAX_JOIN_BODY_BYTES =
  3 *
    (MAX_JOIN_TEXT_CHARS +
      MAX_DISPLAY_NAME_LENGTH +
      MAX_SLUG +
      MAX_JOIN_BELIEFS * MAX_TAB_TITLE_LENGTH +
      2 * MAX_CONTACT_ROWS * MAX_CONTACT_VALUE_LENGTH +
      MAX_TERMS_VERSION) +
  JSON_STRUCTURE_BYTES;

export class ContactEntryDto {
  @IsIn(CONTACT_METHODS)
  method: ContactMethod;

  @IsString()
  @Utf16Length(1, MAX_CONTACT_VALUE_LENGTH)
  value: string;
}

export class JoinBeliefDto {
  /** The tab label, e.g. "God" or "I. Basic Beliefs". */
  @IsString()
  @Utf16Length(1, MAX_TAB_TITLE_LENGTH)
  title: string;

  /** Paragraphs separated by a blank line. */
  @IsString()
  @Utf16Length(1, MAX_BLOCK_TEXT_LENGTH)
  text: string;
}

/**
 * Everything a new member submits to join the Members Community. Bio and at
 * least one belief are required (owner, D10: joining "requires the upload of
 * bio and beliefs"); so are two ways to reach them, the account email being
 * the first (plan §2d item 4).
 */
export class JoinMembershipDto {
  @IsString()
  @Utf16Length(1, MAX_DISPLAY_NAME_LENGTH)
  displayName: string;

  /** Page address, `orgspirituality.org/<slug>`. Lower-cased by the server. */
  @IsString()
  @Utf16Length(2, MAX_SLUG)
  slug: string;

  /** True when the display name is a nickname (anonymous membership). */
  @IsBoolean()
  anonymous: boolean;

  @IsIn(PROFILE_VISIBILITIES)
  visibility: ProfileVisibility;

  @IsString()
  @Utf16Length(1, MAX_BLOCK_TEXT_LENGTH)
  bio: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_JOIN_BELIEFS)
  @ValidateNested({ each: true })
  @Type(() => JoinBeliefDto)
  beliefs: JoinBeliefDto[];

  /** Shown on the page, only if the member adds them. */
  @IsArray()
  @ArrayMaxSize(MAX_CONTACT_ROWS)
  @ValidateNested({ each: true })
  @Type(() => ContactEntryDto)
  contacts: ContactEntryDto[];

  /** Admins only. At least one besides the account email. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CONTACT_ROWS)
  @ValidateNested({ each: true })
  @Type(() => ContactEntryDto)
  backupContacts: ContactEntryDto[];

  /** The terms version the member read and agreed to. */
  @IsString()
  @Utf16Length(0, MAX_TERMS_VERSION)
  termsVersion: string;
}
