import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsString, Max, Min, MinLength, ValidateNested } from 'class-validator';

import { S3_MAX_PARTS } from '../../config/configuration.js';

export class CompletedPartDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(S3_MAX_PARTS)
  partNumber!: number;

  /** The `ETag` response header S3 returned for this part, quotes included. */
  @IsString()
  @MinLength(1)
  etag!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  sizeBytes!: number;
}

export class CompleteUploadDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(S3_MAX_PARTS)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts!: CompletedPartDto[];
}
