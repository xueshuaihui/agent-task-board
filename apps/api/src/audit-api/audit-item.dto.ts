import type { AuditLog } from '@prisma/client';
import { z } from 'zod';
import { auditQuerySchema } from '../contract/schemas';
import { toIso } from '../contract/time';

/** 13 章：审计列表 `page_size` 固定 50，不开放给调用方改——两个消费方共用一套分页。 */
export const AUDIT_PAGE_SIZE = 50;

export interface AuditItemDto {
  id: number;
  created_at: string;
  actor_type: string;
  /** 原文，可能是 Agent 名（`api_tokens.name` 的副本）；系统动作为 null。 */
  actor_name: string | null;
  /** 20.8 的展示口径（`user` → 我、`system` → 系统）由服务端一次定死，两个消费方不再各写一份映射。 */
  actor_label: string;
  action: string;
  target_type: string;
  target_id: string | null;
  /** 7.7：`audit_logs` 只有 before/after 两列 JSON，没有 details 字段；详情列 = 这两份原文。 */
  before: unknown;
  after: unknown;
}

export interface AuditListDto {
  items: AuditItemDto[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

const ACTOR_LABEL: Record<string, string> = { user: '我', system: '系统' };

export function toAuditItem(row: AuditLog): AuditItemDto {
  return {
    id: row.id,
    created_at: toIso(row.createdAt) ?? row.createdAt,
    actor_type: row.actorType,
    actor_name: row.actorName,
    actor_label: ACTOR_LABEL[row.actorType] ?? row.actorName ?? row.actorType,
    // 20.2 末段：动作名不在服务端造中文，表外值也原样下发，由前端渲染「未知（原值）」。
    action: row.action,
    target_type: row.targetType,
    target_id: row.targetId,
    before: parseJson(row.before),
    after: parseJson(row.after),
  };
}

/** 库里存的是 JSON 文本；手改过的坏行不能让整页 500。 */
function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * contract 的 `auditQuerySchema.target_id` 走 `idLike`（≤24 位），而 20.1 的实体 id 是
 * UUID v7（36 位）：Token / 模板 / 字段定义这几类审计都按 UUID 过滤（4.10、7.7），
 * 照抄会让抽屉的审计 Tab 每次请求都 422。这里只放宽长度，其余条件仍由 contract 定义
 * （17.2 的「不加额外过滤参数」、`page` 从 1 起都不变）。contract 把 `idLike` 修好后删掉这段。
 */
export const auditListQuerySchema = auditQuerySchema.extend({
  target_id: z.string().trim().min(3).max(64).optional(),
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;
