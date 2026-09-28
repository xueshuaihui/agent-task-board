import type { BatchResult } from '@/api/types';

/**
 * 批量接口的响应口径：服务端 `TasksService.batch()` **逐条判定、不做整体回滚**（6.13 / 13 章），
 * 每条失败带 `CODE: message`。13 章文档写的是 `skipped[]`，交付说明里提到 `failed[]`，
 * 两者在这里当同一件事读——先取 `failed`、回落 `skipped`，界面文案不受键名漂移影响。
 *
 * 失败原因 → 文案的翻译在 `@/lib/archive-error`（`failureText`）：单条动作与批量动作
 * 说的是同一件事，翻译只留一份。
 */
export interface BatchFailure {
  id: string;
  reason: string;
}

export function failuresOf(result: BatchResult | null | undefined): BatchFailure[] {
  if (!result) return [];
  const raw = result as BatchResult & { failed?: unknown };
  const list = Array.isArray(raw.failed) ? raw.failed : result.skipped;
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      id: String(item.id ?? ''),
      reason: String(item.reason ?? ''),
    }));
}
