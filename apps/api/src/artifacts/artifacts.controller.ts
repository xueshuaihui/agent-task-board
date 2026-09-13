import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AuthScope } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import type { DiffResult } from './artifact-diff';
import { artifactIdSchema, artifactUploadSchema, type ArtifactUploadInput } from './artifact.dto';
import { uploadLimits, uploadStorage } from './artifact-upload';
import { ArtifactsService, type ArtifactMetaDto, type UploadResult } from './artifacts.service';

/**
 * 13 章「产物接口」表，凭证列照抄：上传是 Agent Token，其余是 UI Token；
 * `raw` 与 `thumbnail` 两个资源型端点额外接受一次性签名 URL（见 SignedResourceMiddleware）。
 */
@Controller('api/v1/artifacts')
export class ArtifactsController {
  constructor(private readonly artifacts: ArtifactsService) {}

  @Post()
  @AuthScope('agent')
  @UseInterceptors(FileInterceptor('file', { storage: uploadStorage, limits: uploadLimits }))
  upload(
    @Body(zod(artifactUploadSchema)) body: ArtifactUploadInput,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<UploadResult> {
    return this.artifacts.upload(body, file);
  }

  /** 资源型端点带不了请求头，前端先换 60 秒一次性 URL（13 章「资源型端点例外」）。 */
  @Post(':id/sign')
  @AuthScope('ui')
  sign(@Param('id', zod(artifactIdSchema)) id: string) {
    return this.artifacts.signUrl(id, 'raw');
  }

  /** `raw` 与 `thumbnail` 的签名互不通用，所以要各签一次。 */
  @Post(':id/sign-thumbnail')
  @AuthScope('ui')
  signThumbnail(@Param('id', zod(artifactIdSchema)) id: string) {
    return this.artifacts.signUrl(id, 'thumbnail');
  }

  @Get(':id')
  @AuthScope('ui')
  meta(@Param('id', zod(artifactIdSchema)) id: string): Promise<ArtifactMetaDto> {
    return this.artifacts.meta(id);
  }

  @Get(':id/raw')
  @AuthScope('ui')
  raw(@Param('id', zod(artifactIdSchema)) id: string, @Res() res: Response): Promise<void> {
    return this.artifacts.writeTo(id, 'raw', res);
  }

  @Get(':id/diff')
  @AuthScope('ui')
  diff(
    @Param('id', zod(artifactIdSchema)) id: string,
  ): Promise<DiffResult & { truncated: boolean; name: string }> {
    return this.artifacts.diff(id);
  }

  @Get(':id/thumbnail')
  @AuthScope('ui')
  thumbnail(@Param('id', zod(artifactIdSchema)) id: string, @Res() res: Response): Promise<void> {
    return this.artifacts.writeTo(id, 'thumbnail', res);
  }
}
