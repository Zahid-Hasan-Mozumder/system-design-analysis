import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  HeadBucketCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { AppConfig } from '../config/configuration.js';

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

@Injectable()
export class S3Service implements OnModuleInit {
  private readonly logger = new Logger(S3Service.name);
  private readonly client: S3Client;
  private readonly s3Config: AppConfig['s3'];

  constructor(private readonly config: ConfigService) {
    this.s3Config = this.config.getOrThrow<AppConfig['s3']>('s3');

    this.client = new S3Client({
      region: this.s3Config.region,
      // Fall back to the default credential chain (IAM role, shared profile,
      // SSO) when explicit keys are not supplied.
      credentials:
        this.s3Config.accessKeyId && this.s3Config.secretAccessKey
          ? {
              accessKeyId: this.s3Config.accessKeyId,
              secretAccessKey: this.s3Config.secretAccessKey,
            }
          : undefined,
      endpoint: this.s3Config.endpoint,
      forcePathStyle: this.s3Config.forcePathStyle,
      // The SDK otherwise bakes a checksum header into the signature, which the
      // browser's plain `PUT` to a presigned URL cannot reproduce.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  get bucket(): string {
    return this.s3Config.bucket;
  }

  /**
   * Best-effort bucket bootstrap for local MinIO dev. Never blocks startup: if
   * the store is unreachable or the credentials cannot create a bucket, it logs
   * and moves on so the rest of the app still comes up.
   */
  async onModuleInit(): Promise<void> {
    if (!this.s3Config.autoCreateBucket) return;

    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Bucket "${this.bucket}" already exists`);
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`Created bucket "${this.bucket}"`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Could not ensure bucket "${this.bucket}" exists: ${message}`);
      }
    }
  }

  /** Step 2: ask S3 to open a multipart upload and hand back its UploadId. */
  async createMultipartUpload(objectKey: string, mimeType: string, fileName: string): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: objectKey,
        ContentType: mimeType,
        ContentDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`,
      }),
    );

    if (!result.UploadId) {
      throw new Error('S3 did not return an UploadId for CreateMultipartUpload');
    }

    this.logger.log(`Opened multipart upload ${result.UploadId} for s3://${this.bucket}/${objectKey}`);
    return result.UploadId;
  }

  /** Step 6: presign a single `UploadPart` PUT so the browser can upload directly. */
  async createPresignedPartUrl(
    objectKey: string,
    s3UploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: objectKey,
        UploadId: s3UploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  /** Step 11: tell S3 to stitch the parts into one object. */
  async completeMultipartUpload(
    objectKey: string,
    s3UploadId: string,
    parts: CompletedPart[],
  ): Promise<{ location?: string; etag?: string }> {
    const result = await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: objectKey,
        UploadId: s3UploadId,
        MultipartUpload: {
          // S3 requires parts in ascending PartNumber order.
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
    );

    return { location: result.Location, etag: result.ETag };
  }

  /** Discard an upload and the parts S3 is holding, so storage is not billed. */
  async abortMultipartUpload(objectKey: string, s3UploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: objectKey,
        UploadId: s3UploadId,
      }),
    );
    this.logger.log(`Aborted multipart upload ${s3UploadId} for s3://${this.bucket}/${objectKey}`);
  }

  /**
   * Ask S3 which parts it already holds. Used to resume an interrupted upload
   * without re-sending bytes that already landed.
   */
  async listParts(objectKey: string, s3UploadId: string): Promise<CompletedPart[]> {
    const parts: CompletedPart[] = [];
    let partNumberMarker: string | undefined;

    do {
      const result = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: objectKey,
          UploadId: s3UploadId,
          PartNumberMarker: partNumberMarker,
        }),
      );

      for (const part of result.Parts ?? []) {
        if (part.PartNumber && part.ETag) {
          parts.push({ partNumber: part.PartNumber, etag: part.ETag });
        }
      }

      partNumberMarker = result.IsTruncated ? result.NextPartNumberMarker : undefined;
    } while (partNumberMarker);

    return parts;
  }

  /** Public-style object URL, used when S3 does not return a Location. */
  objectUrl(objectKey: string): string {
    const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');

    if (this.s3Config.endpoint) {
      const base = this.s3Config.endpoint.replace(/\/+$/, '');
      return this.s3Config.forcePathStyle
        ? `${base}/${this.bucket}/${encodedKey}`
        : `${base}/${encodedKey}`;
    }

    return `https://${this.bucket}.s3.${this.s3Config.region}.amazonaws.com/${encodedKey}`;
  }
}
