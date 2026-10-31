import { IsOptional, IsString, MaxLength } from 'class-validator';

export class AbortUploadDto {
  /** Free-text note stored on the row, e.g. "cancelled by user". */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
