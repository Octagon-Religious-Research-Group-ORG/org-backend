import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { TAB_HISTORY_FIELDS, type TabHistoryField } from '../members.dto';

/** Which version a receipt is for; omitted, the current one. */
export class ReceiptQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  seq?: number;
}

export class BeliefReceiptQueryDto extends ReceiptQueryDto {
  @IsOptional()
  @IsIn(TAB_HISTORY_FIELDS)
  field?: TabHistoryField;
}
