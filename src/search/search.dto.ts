import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Utf16Length } from '../membership/utf16-length';
import {
  MAX_RESULT_PAGE,
  SEARCH_TYPES,
  type SearchType,
} from './search-pipeline';
import { FRAGMENT_MAX_LENGTH, MAX_QUERY_LENGTH } from './search-text';

export class SearchQueryDto {
  /** What the reader typed; a longer query is refused, not cut. */
  @IsString()
  @Utf16Length(0, MAX_QUERY_LENGTH)
  q: string;

  @IsOptional()
  @IsIn(SEARCH_TYPES)
  type?: SearchType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_RESULT_PAGE)
  page?: number;
}

export class SetFragmentHiddenDto {
  @IsString()
  @Utf16Length(1, FRAGMENT_MAX_LENGTH * 2)
  term: string;

  @IsBoolean()
  hidden: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
