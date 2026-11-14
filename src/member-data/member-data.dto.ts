import { IsString } from 'class-validator';
import { Utf16Length } from '../membership/utf16-length';

/** "Delete my page": the member types their page's address to confirm. */
export class DeletePageDto {
  @IsString()
  @Utf16Length(1, 200)
  confirm: string;
}
