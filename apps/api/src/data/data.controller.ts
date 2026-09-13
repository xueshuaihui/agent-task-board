import { Body, Controller, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import multer from 'multer';
import type { Response } from 'express';
import { Auth, AuthScope, type RequestAuth } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import { DataService, type ExportResult } from './data.service';
import {
  exportRequestSchema,
  importRequestSchema,
  type ExportRequest,
  type ImportRequest,
} from './data.dto';
import { IMPORT_MAX_BYTES, ImportService } from './import.service';

/**
 * 13 章「数据接口」两行：导出是附件流，导入是 multipart + 预览。
 * 导入文件收进内存解析（几十 MB 的 JSON 不落在磁盘上，省一次清理），硬顶见 `IMPORT_MAX_BYTES`。
 */
@Controller('api/v1/data')
@AuthScope('ui')
export class DataController {
  constructor(
    private readonly data: DataService,
    private readonly imports: ImportService,
  ) {}

  @Post('export')
  async export(
    @Body(zod(exportRequestSchema)) body: ExportRequest,
    @Auth() auth: RequestAuth,
    @Res() res: Response,
  ): Promise<void> {
    const { filename, document }: ExportResult = await this.data.export(body, auth);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(document));
  }

  /** `dry_run=true` 即导入界面的「预览」，只读；确认按钮才带 `dry_run=false`。 */
  @Post('import')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      // multer 的顶留高一档：先让服务侧判出可读的 422，而不是被它断流报 500。
      limits: { files: 1, fileSize: IMPORT_MAX_BYTES + 1024 * 1024 },
    }),
  )
  import(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(zod(importRequestSchema)) body: ImportRequest,
    @Auth() auth: RequestAuth,
  ) {
    return this.imports.run(file, body, auth);
  }
}
