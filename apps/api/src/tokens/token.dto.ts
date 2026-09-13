import type { ApiToken } from '@prisma/client';
import { parseJsonArray } from '../tasks/task.dto';
import { toIso } from '../contract/time';

/**
 * 13 章 Token 接口的出参：既没有 `token_hash`，也没有明文。
 * 明文只在 `POST` 那一次响应里出现（15 章「库中只存 token_hash」的界面后果）。
 */
export interface TokenDto {
  id: string;
  name: string;
  capabilities: string[];
  /** `enabled = 0` 即已吊销；前端据此渲染「○ 已吊销」，不靠隐藏行。 */
  enabled: boolean;
  /** null = 从未使用（原型 7.3：新建未接入的 Token 一眼可辨）。 */
  last_used_at: string | null;
  created_at: string;
}

export interface IssuedTokenDto extends TokenDto {
  /** 一次性明文，关掉对话框就再也取不到。 */
  token: string;
}

export function toTokenDto(row: ApiToken): TokenDto {
  return {
    id: row.id,
    name: row.name,
    capabilities: parseJsonArray(row.capabilities),
    enabled: row.enabled === 1,
    last_used_at: toIso(row.lastUsedAt),
    created_at: toIso(row.createdAt) ?? row.createdAt,
  };
}
