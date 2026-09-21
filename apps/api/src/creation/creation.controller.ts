import { Controller, Get, Param, Post, Body } from '@nestjs/common';
import { AuthScope } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import { creationDecisionSchema, creationRequestCreateSchema, type CreationDecisionInput, type CreationRequestCreateInput } from './creation.dto';
import { CreationService } from './creation.service';

/**
 * v0.0.4 W8-a2 §16.2「creation-requests」端点（UI 凭证组，Agent Token 由全局守卫回 FORBIDDEN）：
 *   GET  /api/v1/creation-requests            待决创建请求列表（轻确认卡片数据源，r3）
 *   POST /api/v1/creation-requests            生成待决创建请求（light 入口的 REST 形态）
 *   POST /api/v1/creation-requests/{id}/decision  用户决策 create / edit / cancel（§8.7 r3）
 * 业务全在 CreationService，本文件零逻辑；错误语义由全局 ApiExceptionFilter 兜底。
 */
@Controller('api/v1/creation-requests')
@AuthScope('ui')
export class CreationController {
  constructor(private readonly creation: CreationService) {}

  @Get()
  list() {
    return this.creation.listRequests();
  }

  @Post()
  create(@Body(zod(creationRequestCreateSchema)) body: CreationRequestCreateInput) {
    return this.creation.createLightRequest(body);
  }

  @Post(':id/decision')
  decide(@Param('id') id: string, @Body(zod(creationDecisionSchema)) body: CreationDecisionInput) {
    return this.creation.decide(id, body);
  }
}
