import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { S3_MAX_PART_SIZE, S3_MAX_PARTS, type AppConfig } from '../config/configuration.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { S3Service } from '../s3/s3.service.js';
import { UploadStatus } from '../generated/prisma/enums.js';
import type { Upload } from '../generated/prisma/client.js';
import type { CompleteUploadDto } from './dto/complete-upload.dto.js';
import type { InitiateUploadDto } from './dto/initiate-upload.dto.js';

/** Shape returned to the browser -- BigInt is not JSON-serializable. */
export interface UploadView {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: string;
  bucket: string;
  objectKey: string;
  status: UploadStatus;
  partSize: number;
  totalParts: number;
  location: string | null;
  etag: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface InitiateUploadResult extends UploadView {
  /** The S3 UploadId. The browser echoes it back only for observability. */
  s3UploadId: string;
}

const ACTIVE_STATUSES: UploadStatus[] = [UploadStatus.PENDING, UploadStatus.UPLOADING];

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private readonly uploadConfig: AppConfig['upload'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    config: ConfigService,
  ) {
    this.uploadConfig = config.getOrThrow<AppConfig['upload']>('upload');
  }

  // -------------------------------------------------------------------------
  // Steps 1-4: open the multipart upload and record it as PENDING.
  // -------------------------------------------------------------------------
  async initiate(dto: InitiateUploadDto): Promise<InitiateUploadResult> {
    const sizeBytes = dto.sizeBytes;

    if (sizeBytes > this.uploadConfig.maxFileBytes) {
      throw new BadRequestException(
        `File is ${sizeBytes} bytes, which exceeds the ${this.uploadConfig.maxFileBytes} byte limit.`,
      );
    }

    const partSize = this.resolvePartSize(sizeBytes);
    const totalParts = Math.ceil(sizeBytes / partSize);
    const mimeType = dto.mimeType ?? 'application/octet-stream';
    const objectKey = this.buildObjectKey(dto.fileName, dto.folder);

    // Step 2: S3 hands back the UploadId.
    const s3UploadId = await this.s3.createMultipartUpload(objectKey, mimeType, dto.fileName);

    // Step 3: persist it before the client sends a single byte, so an
    // interrupted upload is still visible and can be reconciled or aborted.
    let upload: Upload;
    try {
      upload = await this.prisma.upload.create({
        data: {
          fileName: dto.fileName,
          mimeType,
          sizeBytes: BigInt(sizeBytes),
          bucket: this.s3.bucket,
          objectKey,
          s3UploadId,
          partSize,
          totalParts,
          status: UploadStatus.PENDING,
        },
      });
    } catch (error) {
      // Never leave an orphaned multipart upload accruing storage charges.
      await this.safeAbort(objectKey, s3UploadId);
      throw error;
    }

    this.logger.log(
      `Initiated upload ${upload.id}: ${dto.fileName} (${sizeBytes} bytes) as ${totalParts} x ${partSize} byte parts`,
    );

    // Step 4: the client now knows how to slice the file.
    return { ...this.toView(upload), s3UploadId: upload.s3UploadId };
  }

  // -------------------------------------------------------------------------
  // Steps 5-7: presign one part URL.
  // -------------------------------------------------------------------------
  async getPartUrl(
    id: string,
    partNumber: number,
  ): Promise<{ partNumber: number; url: string; expiresIn: number }> {
    const upload = await this.findActive(id);

    if (partNumber > upload.totalParts) {
      throw new BadRequestException(
        `Part ${partNumber} is out of range; this upload has ${upload.totalParts} parts.`,
      );
    }

    const url = await this.s3.createPresignedPartUrl(
      upload.objectKey,
      upload.s3UploadId,
      partNumber,
      this.uploadConfig.urlTtlSeconds,
    );

    // The first part URL handed out means bytes are about to move.
    if (upload.status === UploadStatus.PENDING) {
      await this.prisma.upload.update({
        where: { id: upload.id },
        data: { status: UploadStatus.UPLOADING },
      });
    }

    return { partNumber, url, expiresIn: this.uploadConfig.urlTtlSeconds };
  }

  // -------------------------------------------------------------------------
  // Steps 10-13: finalize, then mark the row COMPLETED.
  // -------------------------------------------------------------------------
  async complete(id: string, dto: CompleteUploadDto): Promise<UploadView> {
    const upload = await this.findActive(id);

    const parts = [...dto.parts].sort((a, b) => a.partNumber - b.partNumber);
    const seen = new Set<number>();
    for (const part of parts) {
      if (seen.has(part.partNumber)) {
        throw new BadRequestException(`Part ${part.partNumber} was submitted more than once.`);
      }
      seen.add(part.partNumber);
      if (part.partNumber > upload.totalParts) {
        throw new BadRequestException(
          `Part ${part.partNumber} is out of range; this upload has ${upload.totalParts} parts.`,
        );
      }
    }

    if (parts.length !== upload.totalParts) {
      throw new BadRequestException(
        `Expected ${upload.totalParts} parts but received ${parts.length}. Upload the missing parts before completing.`,
      );
    }

    let location: string | undefined;
    let etag: string | undefined;

    try {
      // Step 11: S3 stitches the parts together.
      const result = await this.s3.completeMultipartUpload(
        upload.objectKey,
        upload.s3UploadId,
        parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
      );
      location = result.location;
      etag = result.etag;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.upload.update({
        where: { id: upload.id },
        data: { status: UploadStatus.FAILED, errorMessage: message.slice(0, 500) },
      });
      this.logger.error(`CompleteMultipartUpload failed for ${upload.id}: ${message}`);
      throw new InternalServerErrorException(`S3 could not assemble the upload: ${message}`);
    }

    // Step 12: one transaction records the parts and flips the row to COMPLETED.
    const completed = await this.prisma.$transaction(async (tx) => {
      await tx.uploadPart.deleteMany({ where: { uploadId: upload.id } });
      await tx.uploadPart.createMany({
        data: parts.map((part) => ({
          uploadId: upload.id,
          partNumber: part.partNumber,
          etag: part.etag,
          sizeBytes: part.sizeBytes,
        })),
      });

      return tx.upload.update({
        where: { id: upload.id },
        data: {
          status: UploadStatus.COMPLETED,
          location: location ?? this.s3.objectUrl(upload.objectKey),
          etag: etag ?? null,
          errorMessage: null,
          completedAt: new Date(),
        },
      });
    });

    this.logger.log(`Completed upload ${upload.id} -> ${completed.location}`);
    return this.toView(completed);
  }

  // -------------------------------------------------------------------------
  // Cancellation and bookkeeping.
  // -------------------------------------------------------------------------
  async abort(id: string, reason?: string): Promise<UploadView> {
    const upload = await this.findOne(id);

    if (upload.status === UploadStatus.COMPLETED) {
      throw new ConflictException('This upload already completed and cannot be aborted.');
    }

    if (ACTIVE_STATUSES.includes(upload.status) || upload.status === UploadStatus.FAILED) {
      await this.safeAbort(upload.objectKey, upload.s3UploadId);
    }

    const aborted = await this.prisma.upload.update({
      where: { id: upload.id },
      data: {
        status: UploadStatus.ABORTED,
        errorMessage: (reason ?? 'Aborted by client').slice(0, 500),
      },
    });

    return this.toView(aborted);
  }

  /**
   * Which parts S3 already holds for this upload. Lets a client that lost its
   * connection skip the chunks that already landed.
   */
  async status(id: string): Promise<UploadView & { uploadedParts: number[] }> {
    const upload = await this.findOne(id);

    if (!ACTIVE_STATUSES.includes(upload.status)) {
      return { ...this.toView(upload), uploadedParts: [] };
    }

    const parts = await this.s3.listParts(upload.objectKey, upload.s3UploadId);
    return {
      ...this.toView(upload),
      uploadedParts: parts.map((part) => part.partNumber).sort((a, b) => a - b),
    };
  }

  async list(limit = 25): Promise<UploadView[]> {
    const uploads = await this.prisma.upload.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return uploads.map((upload) => this.toView(upload));
  }

  async get(id: string): Promise<UploadView> {
    return this.toView(await this.findOne(id));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * S3 caps a multipart upload at 10,000 parts, so the configured part size is
   * doubled until the file fits. A 2 GB file at the 16 MiB default needs 128
   * parts; the ceiling only starts to bind past ~160 GB.
   */
  private resolvePartSize(sizeBytes: number): number {
    let partSize = this.uploadConfig.partSizeBytes;

    while (Math.ceil(sizeBytes / partSize) > S3_MAX_PARTS && partSize < S3_MAX_PART_SIZE) {
      partSize = Math.min(partSize * 2, S3_MAX_PART_SIZE);
    }

    if (Math.ceil(sizeBytes / partSize) > S3_MAX_PARTS) {
      throw new BadRequestException(
        `File is too large: ${sizeBytes} bytes cannot be split into ${S3_MAX_PARTS} parts of at most ${S3_MAX_PART_SIZE} bytes.`,
      );
    }

    return partSize;
  }

  private buildObjectKey(fileName: string, folder?: string): string {
    // Keep the extension but strip anything that would be awkward in a key.
    const safeName = fileName
      .normalize('NFKD')
      .replace(/[^\w.\-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
      .slice(-120);

    const now = new Date();
    const datePath = [
      now.getUTCFullYear(),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      String(now.getUTCDate()).padStart(2, '0'),
    ].join('/');

    const safeFolder = folder?.replace(/[^\w/\-]+/g, '-').replace(/^\/+|\/+$/g, '');

    return [this.uploadConfig.keyPrefix, safeFolder, datePath, `${randomUUID()}-${safeName || 'file'}`]
      .filter(Boolean)
      .join('/');
  }

  private async findOne(id: string): Promise<Upload> {
    const upload = await this.prisma.upload.findUnique({ where: { id } });
    if (!upload) {
      throw new NotFoundException(`No upload with id ${id}`);
    }
    return upload;
  }

  private async findActive(id: string): Promise<Upload> {
    const upload = await this.findOne(id);
    if (!ACTIVE_STATUSES.includes(upload.status)) {
      throw new ConflictException(
        `Upload ${id} is ${upload.status}; only PENDING or UPLOADING uploads accept parts.`,
      );
    }
    return upload;
  }

  /** Abort without letting a secondary failure mask the original error. */
  private async safeAbort(objectKey: string, s3UploadId: string): Promise<void> {
    try {
      await this.s3.abortMultipartUpload(objectKey, s3UploadId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not abort multipart upload ${s3UploadId} for ${objectKey}: ${message}`);
    }
  }

  private toView(upload: Upload): UploadView {
    return {
      id: upload.id,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes.toString(),
      bucket: upload.bucket,
      objectKey: upload.objectKey,
      status: upload.status,
      partSize: upload.partSize,
      totalParts: upload.totalParts,
      location: upload.location,
      etag: upload.etag,
      errorMessage: upload.errorMessage,
      createdAt: upload.createdAt.toISOString(),
      updatedAt: upload.updatedAt.toISOString(),
      completedAt: upload.completedAt?.toISOString() ?? null,
    };
  }
}
