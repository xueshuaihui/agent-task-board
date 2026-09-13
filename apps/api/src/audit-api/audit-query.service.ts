import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuditQuery } from '../contract/schemas';
import { PrismaService } from '../infra/prisma.service';
import { AUDIT_PAGE_SIZE, toAuditItem, type AuditListDto } from './audit-item.dto';

/**
 * 6.8 的只读侧。写入侧在 `infra/audit.service.ts`，本类一行都不写。
 * 设置页「日志与审计」Tab 与任务详情抽屉「审计」Tab 走同一个方法、同一份 DTO，
 * 差别只是抽屉传 `target_id`（13 章读取模型）。
 */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AuditQuery): Promise<AuditListDto> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.target_type ? { targetType: query.target_type } : {}),
      ...(query.target_id ? { targetId: query.target_id } : {}),
    };
    const total = await this.prisma.auditLog.count({ where });
    const rows = await this.prisma.auditLog.findMany({
      where,
      // `created_at` 只到秒，同一秒内多条是常态；不带自增 id 兜底，翻页会出现重复行与漏行。
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * AUDIT_PAGE_SIZE,
      take: AUDIT_PAGE_SIZE,
    });
    return {
      items: rows.map(toAuditItem),
      page: query.page,
      page_size: AUDIT_PAGE_SIZE,
      total,
      // 空表也返回 1 页：原型 7.7 的分页条要显示「第 1 / 1 页」，而不是除以 0。
      total_pages: Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE)),
    };
  }
}
