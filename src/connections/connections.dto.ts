import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { ContactEntryDto } from '../membership/membership.dto';
import { Utf16Length } from '../membership/utf16-length';
import { MAX_TERM_LENGTH } from './connection-terms.service';
import {
  MAX_CONNECTION_CONTACT_ROWS,
  OPEN_TO_VALUES,
  type OpenTo,
} from './schemas/connection-settings.schema';
import { MAX_CONNECTION_NOTE_LENGTH } from './schemas/connection.schema';

/** A page address may be typed in any case; the service lowercases it. */
const SLUG_INPUT = /^[A-Za-z0-9-]{1,80}$/;
/** A record's database id. */
export const RECORD_ID = /^[0-9a-f]{24}$/i;

export class SendConnectionDto {
  @IsString()
  @Matches(SLUG_INPUT)
  slug: string;

  /**
   * Optional; above the stored limit because cleaning removes control
   * characters first, then the service refuses a longer cleaned note.
   */
  @IsOptional()
  @IsString()
  @Utf16Length(0, 3 * MAX_CONNECTION_NOTE_LENGTH)
  note?: string;
}

/** Block by the member's page, or by a request between the two. */
export class BlockDto {
  @IsOptional()
  @IsString()
  @Matches(SLUG_INPUT)
  slug?: string;

  @IsOptional()
  @IsString()
  @Matches(RECORD_ID)
  connectionId?: string;
}

export class ConnectionSettingsDto {
  @IsOptional()
  @IsIn(OPEN_TO_VALUES)
  openTo?: OpenTo;

  /** Rows shown to connected members only. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CONNECTION_CONTACT_ROWS)
  @ValidateNested({ each: true })
  @Type(() => ContactEntryDto)
  contacts?: ContactEntryDto[];
}

/** The feature's name (admins); both empty puts the default back. */
export class ConnectionTermsDto {
  @IsString()
  @Utf16Length(0, MAX_TERM_LENGTH)
  singular: string;

  @IsString()
  @Utf16Length(0, MAX_TERM_LENGTH)
  plural: string;
}
