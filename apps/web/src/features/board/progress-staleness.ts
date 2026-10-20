import { formatRelative, parseIso } from '@/lib/time';

/**
 * #6「最后上报时间 / 是否停滞」的纯展示判据。
 *
 * 只看 `progress_updated_at` 与本地时钟的差值：超过阈值只提示「可能已停滞」，
 * **不**推导任务状态、**不**断言 Agent 已停止——真正的回收/失败判定仍归服务端
 * （租约回收、Run 回写）。历史 Run 没记录该列时返回 null，界面不伪造时间。
 */
export const PROGRESS_STALE_AFTER_MS = 5 * 60_000;

export interface ProgressReportDisplay {
  /** 「最后上报 2 分钟前」；无时间戳或非法时间时为 null（调用方不渲染）。 */
  text: string | null;
  /** 距上次上报 ≥ 5 分钟；无时间戳 / 非法时间 / 未来时间恒为 false。 */
  stale: boolean;
  /** 距上次上报的毫秒数；无时间戳或非法时间为 null。 */
  ageMs: number | null;
}

export function progressReportDisplay(
  progressUpdatedAt: string | null | undefined,
  now: number = Date.now(),
): ProgressReportDisplay {
  const at = parseIso(progressUpdatedAt);
  if (!at) return { text: null, stale: false, ageMs: null };
  const ageMs = now - at.getTime();
  return {
    text: `最后上报 ${formatRelative(progressUpdatedAt, now)}`,
    stale: ageMs >= PROGRESS_STALE_AFTER_MS,
    ageMs,
  };
}
