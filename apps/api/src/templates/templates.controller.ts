import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { AuthScope } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import {
  templateCreateBodySchema,
  templatePatchBodySchema,
  type TemplateCreateBody,
  type TemplatePatchBody,
} from './template.dto';
import { TemplatesService } from './templates.service';

/**
 * 13 章「模板接口」四条。15 章把「配置字段定义 / 模板」判为用户专属，全部走 UI 凭证组。
 * 建任务时读模板走同一个 `GET /templates`——列表页/新建菜单要的就是这份预填集合。
 */
@Controller('api/v1/templates')
@AuthScope('ui')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list() {
    return this.templates.list();
  }

  @Post()
  create(@Body(zod(templateCreateBodySchema)) body: TemplateCreateBody) {
    return this.templates.create(body);
  }

  @Patch(':id')
  patch(@Param('id') id: string, @Body(zod(templatePatchBodySchema)) body: TemplatePatchBody) {
    return this.templates.patch(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.templates.remove(id);
  }
}
