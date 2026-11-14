import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, ValidateNested } from 'class-validator';

/** Each category, on or off; a field left out stays as it is. */
export class CategoryTogglesDto {
  @IsOptional() @IsBoolean() comments?: boolean;
  @IsOptional() @IsBoolean() replies?: boolean;
  @IsOptional() @IsBoolean() suggestions?: boolean;
  @IsOptional() @IsBoolean() votes?: boolean;
  @IsOptional() @IsBoolean() claims?: boolean;
  @IsOptional() @IsBoolean() moderation?: boolean;
  @IsOptional() @IsBoolean() adminPages?: boolean;
  @IsOptional() @IsBoolean() adminEam?: boolean;
  @IsOptional() @IsBoolean() adminReports?: boolean;
  @IsOptional() @IsBoolean() adminClaims?: boolean;
}

/** A change from the settings page. */
export class NotificationSettingsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CategoryTogglesDto)
  categories?: CategoryTogglesDto;

  @IsOptional() @IsBoolean() digest?: boolean;
  @IsOptional() @IsBoolean() immediate?: boolean;
  @IsOptional() @IsBoolean() adminImmediate?: boolean;
}
