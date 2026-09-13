import { Controller, Get, Query } from '@nestjs/common';
import { AuthScope } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import { AuditQueryService } from './audit-query.service';
import { type AuditListQuery, auditListQuerySchema } from './audit-item.dto';

/**
 * `GET /api/v1/audit?target_type=&target_id=&page=`（13 章读取模型）。
 * 除这两个过滤参数外不再接受别的条件：17.2 明确阶段一不做按对象/操作人/时间筛选，
 * `page_size` 也不在查询串里出现，固定 50。
 * 入参校验用本模块放宽过长度的一版（`target_id` 是 36 位 UUID，contract 的 `idLike` 装不下）。
 */
@Controller('api/v1/audit')
@AuthScope('ui')
export class AuditApiController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get()
  list(@Query(zod(auditListQuerySchema)) query: AuditListQuery) {
    return this.audit.list(query);
  }
}
