-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'UPLOADING', 'COMPLETED', 'ABORTED', 'FAILED');

-- CreateTable
CREATE TABLE "Upload" (
    "id" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "sizeBytes" BIGINT NOT NULL,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "s3UploadId" TEXT NOT NULL,
    "partSize" INTEGER NOT NULL,
    "totalParts" INTEGER NOT NULL,
    "status" "UploadStatus" NOT NULL DEFAULT 'PENDING',
    "location" TEXT,
    "etag" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadPart" (
    "id" UUID NOT NULL,
    "uploadId" UUID NOT NULL,
    "partNumber" INTEGER NOT NULL,
    "etag" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadPart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Upload_status_idx" ON "Upload"("status");

-- CreateIndex
CREATE INDEX "Upload_createdAt_idx" ON "Upload"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Upload_objectKey_s3UploadId_key" ON "Upload"("objectKey", "s3UploadId");

-- CreateIndex
CREATE INDEX "UploadPart_uploadId_idx" ON "UploadPart"("uploadId");

-- CreateIndex
CREATE UNIQUE INDEX "UploadPart_uploadId_partNumber_key" ON "UploadPart"("uploadId", "partNumber");

-- AddForeignKey
ALTER TABLE "UploadPart" ADD CONSTRAINT "UploadPart_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload"("id") ON DELETE CASCADE ON UPDATE CASCADE;
