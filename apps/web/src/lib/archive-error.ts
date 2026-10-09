import { ERROR_CODE_COPY, errorMessage, isApiError } from '@/api';
import type { ErrorCode } from '@/api/types';
import { COPY } from '@/lib/copy';

/**
 * 6.13.1 归档/恢复被下游挡住时的界面文案（4.5 统一文案表，不自行措辞）。
 *
 * 放在 `lib` 而不是 `features/task-list`：看板卡片菜单与列表行菜单现在共用同一份
 * `⋯` 动作集（原型 3.8 第 822 行），这条 409 的复述也就必须同源——曾经它只在列表页的
 * 行动作 mutation 上，看板侧走服务端裸 message，同一个动作两处措辞不一致。
 */

/** 服务端 message 里带条数（「是 N 个」），`context.downstream` 带清单，两个都认。 */
export function archiveBlockedCount(text: string): number | null {
  const match = /是\s*(\d+)\s*个/.exec(text);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 单任务归档/恢复的失败：409 的 `context.downstream` 就是阻塞它的未完成任务。 */
export function archiveErrorText(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'ARCHIVE_BLOCKED_BY_DEPENDENCY') {
      const downstream = error.context.downstream;
      const count = Array.isArray(downstream) ? downstream.length : archiveBlockedCount(error.message);
      return COPY.archiveBlocked(count ?? 1);
    }
    // 需求归档：子任务未完成
    if (error.code === 'ARCHIVE_BLOCKED_BY_CHILDREN') {
      const activeChildren = error.context.active_children;
      const count = Array.isArray(activeChildren) ? activeChildren.length : null;
      return `需求下还有${count ? ` ${count} ` : ''}个活跃子任务，请先完成或归档这些子任务`;
    }
  }
  return errorMessage(error);
}

/** 批量接口逐条回 `CODE: message`；这里是单条失败原因 → 界面文案。 */
export function failureText(reason: string): string {
  const split = reason.indexOf(': ');
  const code = split > 0 ? reason.slice(0, split).trim() : '';
  const message = split > 0 ? reason.slice(split + 2).trim() : reason.trim();
  if (code === 'ARCHIVE_BLOCKED_BY_DEPENDENCY') {
    return COPY.archiveBlocked(archiveBlockedCount(message) ?? archiveBlockedCount(reason) ?? 1);
  }
  if (code === 'ARCHIVE_BLOCKED_BY_CHILDREN') {
    // 从 message 中提取数字（「需求下还有 N 个活跃子任务」）
    const match = /(\d+)/.exec(message);
    const count = match ? match[1] : '';
    return `需求下还有${count ? ` ${count} ` : ''}个活跃子任务，请先完成或归档这些子任务`;
  }
  if (message) return message;
  return ERROR_CODE_COPY[code as ErrorCode] ?? ERROR_CODE_COPY.UNKNOWN;
}
