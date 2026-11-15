import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { MAX_LOG_SIZE } from './anchor-log.service';

/** `GET /anchors/proof/inclusion?day=YYYY-MM-DD[&size=N]` (Chunk 16b). */
export class InclusionProofQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  day: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LOG_SIZE)
  size?: number;
}

/** `GET /anchors/proof/consistency?from=M&to=N` (Chunk 16b). */
export class ConsistencyProofQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LOG_SIZE)
  from: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LOG_SIZE)
  to: number;
}

/** `GET /anchors/entries?from=M&to=N` (review round 1, M2a). */
export class EntriesQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_LOG_SIZE)
  from: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_LOG_SIZE)
  to: number;
}
