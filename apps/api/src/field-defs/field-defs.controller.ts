import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { fieldDefCreateSchema, fieldDefPatchSchema } from '../contract/schemas';
import type { FieldDefCreateInput, FieldDefPatchInput } from '../contract/schemas';
import { Auth, AuthScope, type RequestAuth } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import { FieldDefsService } from './field-defs.service';

/** 13 章「自定义字段接口」：全部只吃 UI 凭证。 */
@Controller('api/v1/field-defs')
@AuthScope('ui')
export class FieldDefsController {
  constructor(private readonly defs: FieldDefsService) {}

  @Get()
  list(@Auth() auth: RequestAuth) {
    return this.defs.list(auth.accountId);
  }

  @Post()
  create(@Body(zod(fieldDefCreateSchema)) body: FieldDefCreateInput, @Auth() auth: RequestAuth) {
    return this.defs.create(auth.accountId, body);
  }

  @Patch(':id')
  patch(
    @Param('id') id: string,
    @Body(zod(fieldDefPatchSchema)) body: FieldDefPatchInput,
    @Auth() auth: RequestAuth,
  ) {
    return this.defs.patch(auth.accountId, id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Auth() auth: RequestAuth) {
    return this.defs.remove(auth.accountId, id);
  }
}
