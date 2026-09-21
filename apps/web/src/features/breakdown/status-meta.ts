import type { BreakdownSessionStatus } from '@/api/types';
import type { StatusStyle } from '@/lib/status-style';

/**
 * §7.7 六态徽标的颜色映射：色板复用 `lib/status-style` 的 1.1 token（组件里不出现十六进制色）。
 * 语义就近取任务状态色：接收中=RUNNING（进行中）、待确认=REVIEW（等用户动作）、
 * 创建中=READY、已完成=DONE、已取消=BACKLOG（灰）、已中断=FAILED。
 */
export const BREAKDOWN_STATUS_STYLE: Record<BreakdownSessionStatus, StatusStyle> = {
  receiving: { dot: 'bg-status-running', soft: 'bg-status-running-soft', text: 'text-status-running', bar: 'bg-status-running' },
  reviewing: { dot: 'bg-status-review', soft: 'bg-status-review-soft', text: 'text-status-review', bar: 'bg-status-review' },
  creating: { dot: 'bg-status-ready', soft: 'bg-status-ready-soft', text: 'text-status-ready', bar: 'bg-status-ready' },
  completed: { dot: 'bg-status-done', soft: 'bg-status-done-soft', text: 'text-status-done', bar: 'bg-status-done' },
  cancelled: { dot: 'bg-status-backlog', soft: 'bg-status-backlog-soft', text: 'text-status-backlog', bar: 'bg-status-backlog' },
  interrupted: { dot: 'bg-status-failed', soft: 'bg-status-failed-soft', text: 'text-status-failed', bar: 'bg-status-failed' },
};

/** §7.3 切换器红点：未终结（可继续流转或等用户动作）的会话。 */
export const BREAKDOWN_PENDING_STATUSES: readonly BreakdownSessionStatus[] = [
  'receiving',
  'reviewing',
  'creating',
];

export function isBreakdownPending(status: BreakdownSessionStatus): boolean {
  return BREAKDOWN_PENDING_STATUSES.includes(status);
}
