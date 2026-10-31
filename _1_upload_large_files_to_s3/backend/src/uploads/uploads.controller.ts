import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';

import { AbortUploadDto } from './dto/abort-upload.dto.js';
import { CompleteUploadDto } from './dto/complete-upload.dto.js';
import { InitiateUploadDto } from './dto/initiate-upload.dto.js';
import { PartUrlDto } from './dto/part-url.dto.js';
import { UploadsService } from './uploads.service.js';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  /** Steps 1-4: open the multipart upload, store it as PENDING, return the part plan. */
  @Post('initiate')
  @HttpCode(HttpStatus.CREATED)
  initiate(@Body() dto: InitiateUploadDto) {
    return this.uploads.initiate(dto);
  }

  /** Steps 5-7: hand the client a presigned PUT URL for one part. */
  @Post(':id/part-url')
  @HttpCode(HttpStatus.OK)
  partUrl(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PartUrlDto) {
    return this.uploads.getPartUrl(id, dto.partNumber);
  }

  /** Steps 10-13: finalize in S3, then mark the row COMPLETED. */
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  complete(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CompleteUploadDto) {
    return this.uploads.complete(id, dto);
  }

  /** Cancel: discard the parts S3 is holding and mark the row ABORTED. */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  abort(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AbortUploadDto) {
    return this.uploads.abort(id, dto?.reason);
  }

  /** Which parts S3 already holds -- used to resume an interrupted upload. */
  @Get(':id/status')
  status(@Param('id', ParseUUIDPipe) id: string) {
    return this.uploads.status(id);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.uploads.get(id);
  }

  @Get()
  list(@Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number) {
    return this.uploads.list(limit);
  }
}
