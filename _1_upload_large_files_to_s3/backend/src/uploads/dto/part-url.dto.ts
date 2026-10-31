import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

import { S3_MAX_PARTS } from '../../config/configuration.js';

export class PartUrlDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(S3_MAX_PARTS)
  partNumber!: number;
}
