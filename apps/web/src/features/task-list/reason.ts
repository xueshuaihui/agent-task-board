import { ERROR_CODE_COPY, errorMessage, isApiError } from '@/api';
import type { BatchResult, ErrorCode } from '@/api/types';
import { COPY } from '@/lib/copy';

/**
 * 批量接口的响应口径：服务端 `TasksService.batch()` **逐条判定、不做整体回滚**（6.13 / 13 章），
 * 每条失败带 `CODE: message`。13 章文档写的是 `skipped[]`，交付说明里提到 `failed[]`，
 * 两者在这里当同一件事读——先取 `failed`、回落 `skipped`，界面文案不受键名漂移影响。
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

/** 6.13.1：归档被依赖阻塞的条数——服务端 message 里带，前端按 `COPY.archiveBlocked(n)` 复述。 */
function blockedCount(text: string): number | null {
  const match = /是\s*(\d+)\s*个/.exec(text);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 单条失败原因 → 界面文案（4.5 统一文案表，不自行措辞）。 */
export function failureText(reason: string): string {
  const split = reason.indexOf(': ');
  const code = split > 0 ? reason.slice(0, split).trim() : '';
  const message = split > 0 ? reason.slice(split + 2).trim() : reason.trim();
  if (code === 'ARCHIVE_BLOCKED_BY_DEPENDENCY') {
    return COPY.archiveBlocked(blockedCount(message) ?? blockedCount(reason) ?? 1);
  }
  if (message) return message;
  return ERROR_CODE_COPY[code as ErrorCode] ?? ERROR_CODE_COPY.UNKNOWN;
}

/** 单任务归档/恢复的失败：409 的 `context.downstream` 就是阻塞它的未完成任务。 */
export function archiveErrorText(error: unknown): string {
  if (isApiError(error) && error.code === 'ARCHIVE_BLOCKED_BY_DEPENDENCY') {
    const downstream = error.context.downstream;
    const count = Array.isArray(downstream) ? downstream.length : blockedCount(error.message);
    return COPY.archiveBlocked(count ?? 1);
  }
  return errorMessage(error);
}
