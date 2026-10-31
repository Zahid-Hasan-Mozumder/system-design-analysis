import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';

export class InitiateUploadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName!: string;

  /**
   * Browsers report `File.size` as a Number, which is exact up to 2^53 bytes --
   * far beyond any S3 object -- so a numeric field is safe here. It is widened
   * to BigInt before it reaches Postgres.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sizeBytes!: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(/^[\w.+-]+\/[\w.+-]+$/, { message: 'mimeType must look like "type/subtype"' })
  mimeType?: string;

  /** Optional folder inside the configured key prefix, e.g. "invoices/2026". */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/^\/+|\/+$/g, '') : value))
  folder?: string;
}
