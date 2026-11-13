import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  INBOX_STATUSES,
  type InboxStatus,
  MAX_INBOX_NOTE_LENGTH,
} from '../../admin-inbox/schemas/admin-inbox.schema';
import { MAX_REASON_LENGTH } from '../../auth/roles.service';
import { Utf16Length } from '../../membership/utf16-length';
import { MAX_REMOVAL_REASON_LENGTH } from '../../social/schemas/social-profile.schema';
import { MEMBER_FILTERS, type MemberFilter } from './admin-members.service';
import type { InviteAs } from './admin-roles.service';

/** A Clerk user id, as the admin screens send it. */
export const USER_ID_PATTERN = /^user_[A-Za-z0-9_]{1,64}$/;
/** A Clerk invitation id. */
export const INVITATION_ID_PATTERN = /^inv_[A-Za-z0-9]{1,64}$/;

/** Most list pages a client may ask for. */
export const MAX_LIST_PAGE = 1_000;

export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIST_PAGE)
  page?: number;
}

export class MembersQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(MEMBER_FILTERS)
  status?: MemberFilter;

  /** Part of a name or page address. */
  @IsOptional()
  @IsString()
  @Utf16Length(0, 100)
  q?: string;
}

export class InboxQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(INBOX_STATUSES)
  status?: InboxStatus;
}

/**
 * Longest reason a client may SEND: above what is stored, because cleaning
 * removes control characters first; the service then refuses a cleaned text
 * over the limit with a specific message.
 */
export class ReasonDto {
  @IsString()
  @Utf16Length(1, 3 * MAX_REMOVAL_REASON_LENGTH)
  reason: string;
}

export class RoleChangeDto {
  @IsString()
  @Utf16Length(1, MAX_REASON_LENGTH)
  reason: string;
}

export class InviteDto {
  @IsEmail()
  @Utf16Length(3, 254)
  email: string;

  @IsIn(['admin', 'member'])
  as: InviteAs;

  @IsOptional()
  @IsString()
  @Utf16Length(0, 3 * MAX_REASON_LENGTH)
  reason?: string;
}

export class EamRequestDto {
  /** Optional; what the member wants Tripp to know. */
  @IsOptional()
  @IsString()
  @Utf16Length(0, 3 * MAX_INBOX_NOTE_LENGTH)
  note?: string;
}
