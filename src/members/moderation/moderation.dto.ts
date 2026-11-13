import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { Utf16Length } from '../../membership/utf16-length';
import {
  MAX_REPORT_NOTE_LENGTH,
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  type ReportReason,
  type ReportStatus,
  type ReportTargetType,
} from '../../moderation/schemas/report.schema';
import { PageQueryDto } from '../admin/admin.dto';
import { ID_PATTERN } from '../comments/comments.dto';

/** A page address may be typed in any case; the service lowercases it. */
const SLUG_INPUT = /^[A-Za-z0-9-]{1,80}$/;
/** A member page's database id, as the queue names it. */
export const PAGE_ID_PATTERN = /^[0-9a-f]{24}$/i;

export class NewReportDto {
  @IsIn(REPORT_TARGET_TYPES)
  targetType: ReportTargetType;

  /** The comment, when `targetType` is `comment`. */
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN)
  commentId?: string;

  /** The member page, when `targetType` is `member-page`. */
  @IsOptional()
  @IsString()
  @Matches(SLUG_INPUT)
  slug?: string;

  @IsIn(REPORT_REASONS)
  reason: ReportReason;

  /**
   * Optional; above the stored limit because cleaning removes control
   * characters first, then the service refuses a longer cleaned note.
   */
  @IsOptional()
  @IsString()
  @Utf16Length(0, 3 * MAX_REPORT_NOTE_LENGTH)
  note?: string;
}

export class QueueQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(REPORT_STATUSES)
  status?: ReportStatus;
}
