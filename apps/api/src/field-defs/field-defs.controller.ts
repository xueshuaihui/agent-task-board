import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { fieldDefCreateSchema, fieldDefPatchSchema } from '../contract/schemas';
import type { FieldDefCreateInput, FieldDefPatchInput } from '../contract/schemas';
import { AuthScope } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import { FieldDefsService } from './field-defs.service';

/** 13 章「自定义字段接口」：全部只吃 UI 凭证。 */
@Controller('api/v1/field-defs')
@AuthScope('ui')
export class FieldDefsController {
  constructor(private readonly defs: FieldDefsService) {}

  @Get()
  list() {
    return this.defs.list();
  }

  @Post()
  create(@Body(zod(fieldDefCreateSchema)) body: FieldDefCreateInput) {
    return this.defs.create(body);
  }

  @Patch(':id')
  patch(
    @Param('id') id: string,
    @Body(zod(fieldDefPatchSchema)) body: FieldDefPatchInput,
  ) {
    return this.defs.patch(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.defs.remove(id);
  }
}
