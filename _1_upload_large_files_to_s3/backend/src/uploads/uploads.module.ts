import { Module } from '@nestjs/common';

import { S3Module } from '../s3/s3.module.js';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

@Module({
  imports: [S3Module],
  controllers: [UploadsController],
  providers: [UploadsService],
})
export class UploadsModule {}
