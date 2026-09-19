import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import multer from 'multer';
import type { Response } from 'express';
import { Auth, AuthScope, type RequestAuth } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import { SkillsService, SKILL_IMPORT_MAX_BYTES } from './skills.service';
import {
  skillCreateSchema,
  skillImportMarkdownSchema,
  skillListQuerySchema,
  skillPatchSchema,
  skillRollbackSchema,
  skillSourceScanSchema,
  skillSourcesSchema,
  skillTestSchema,
  skillVersionCreateSchema,
  type SkillCreateInput,
  type SkillImportMarkdownInput,
  type SkillListQuery,
  type SkillPatchInput,
  type SkillSourcesInput,
  type SkillVersionCreateInput,
} from './skills.dto';

/**
 * 8.1-8.8 技能管理接口：UI 凭证组（默认 scope），全部按请求账号隔离。
 * 声明顺序注意：`skills/import` 必须排在 `skills/:id` 系列之前——Nest 按方法声明顺序
 * 匹配路由，`POST /skills/import` 若排在 `POST /skills/:id/...` 之后没有冲突，但
 * 统一前置更稳。
 */
@Controller('api/v1/skills')
@AuthScope('ui')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  list(@Query(zod(skillListQuerySchema)) query: SkillListQuery, @Auth() auth: RequestAuth) {
    return this.skills.list(query, auth.accountId);
  }

  @Post()
  create(@Body(zod(skillCreateSchema)) body: SkillCreateInput, @Auth() auth: RequestAuth) {
    return this.skills.create(body, auth.accountId);
  }

  @Post('import')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: { files: 1, fileSize: SKILL_IMPORT_MAX_BYTES + 1024 * 1024 },
    }),
  )
  import(@UploadedFile() file: Express.Multer.File | undefined, @Auth() auth: RequestAuth) {
    return this.skills.import(file, auth.accountId);
  }

  /** 8.7 SKILL.md / Cursor Rules（.mdc）导入：JSON {filename, content}。 */
  @Post('import-markdown')
  importMarkdown(
    @Body(zod(skillImportMarkdownSchema)) body: SkillImportMarkdownInput,
    @Auth() auth: RequestAuth,
  ) {
    return this.skills.importMarkdown(body, auth.accountId);
  }

  /** 8.8 技能源：settings kv 存 JSON 数组。静态段必须排在 `:id` 系列之前。 */
  @Get('sources')
  async listSources() {
    return { items: await this.skills.listSources() };
  }

  @Put('sources')
  async saveSources(@Body(zod(skillSourcesSchema)) body: SkillSourcesInput) {
    return { items: await this.skills.saveSources(body) };
  }

  @Post('sources/scan')
  scanSource(@Body(zod(skillSourceScanSchema)) body: { source_id: string }) {
    return this.skills.scanSource(body.source_id);
  }

  @Get(':id')
  detail(@Param('id') id: string, @Auth() auth: RequestAuth) {
    return this.skills.detail(id, auth.accountId);
  }

  @Get(':id/tasks')
  boundTasks(@Param('id') id: string, @Auth() auth: RequestAuth) {
    return this.skills.boundTasks(id, auth.accountId);
  }

  @Patch(':id')
  patch(
    @Param('id') id: string,
    @Body(zod(skillPatchSchema)) body: SkillPatchInput,
    @Auth() auth: RequestAuth,
  ) {
    return this.skills.patch(id, auth.accountId, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Auth() auth: RequestAuth) {
    return this.skills.remove(id, auth.accountId);
  }

  @Post(':id/versions')
  createVersion(
    @Param('id') id: string,
    @Body(zod(skillVersionCreateSchema)) body: SkillVersionCreateInput,
    @Auth() auth: RequestAuth,
  ) {
    return this.skills.createVersion(id, auth.accountId, body);
  }

  @Post(':id/rollback')
  rollback(
    @Param('id') id: string,
    @Body(zod(skillRollbackSchema)) body: { version: string },
    @Auth() auth: RequestAuth,
  ) {
    return this.skills.rollback(id, auth.accountId, body.version);
  }

  @Post(':id/test')
  test(
    @Param('id') id: string,
    @Body(zod(skillTestSchema)) body: { input: string },
    @Auth() auth: RequestAuth,
  ) {
    return this.skills.test(id, auth.accountId, body.input);
  }

  /** 导出是附件流，走 @Res 直写（pattern 与 data/export 一致）。 */
  @Get(':id/export')
  async export(@Param('id') id: string, @Auth() auth: RequestAuth, @Res() res: Response) {
    await this.skills.export(id, auth.accountId, res);
  }

  /** 8.7 导出 SKILL.md：text/markdown 附件（name.md）。 */
  @Get(':id/export-markdown')
  async exportMarkdown(@Param('id') id: string, @Auth() auth: RequestAuth, @Res() res: Response) {
    await this.skills.exportMarkdown(id, auth.accountId, res);
  }
}
