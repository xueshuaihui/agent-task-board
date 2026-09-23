import { useEffect, useState } from 'react';
import { useTaskList } from '@/api';
import { formatDateTime, formatRelative, parseIso } from '@/lib/time';
import { STATUS_STYLE } from '@/lib/status-style';
import { cn } from '@/lib/cn';

/**
 * B2b：TopBar 的「执行中 N + 最近活动」紧凑状态 chip。
 * 回应用户 bug「不清楚 Agent 是否还在执行任务」——纯 web 侧读已有 `GET /tasks`：
 * - 计数：`status=RUNNING` 过滤后取分页 `total`（后端 `where.status = { in: [...] }`，
 *   `apps/api/src/tasks/tasks.service.ts`，零 api 改动）；
 * - 最近活动：列表默认 `sort=updated_at&order=desc`（`contract/schemas.ts` 的
 *   `listQuerySchema` 默认值），取首条 `updated_at`——Agent 领取/回写都会推进任务行的
 *   `updated_at`（`agent/writeback.service.ts`）。执行中优先用 RUNNING 集合的首条；
 *   全部落回非 RUNNING 后再看一次全局最新（enabled 门控，两查不同时打）。
 * 新鲜度沿用 13 章读取模型：WS `task.*` / `run.*` 事件的 default 分支会失效
 * `qk.tasksRoot`（`ws/invalidate.ts`），本组件的两条查询都挂在 `['tasks', …]` 前缀下，
 * 断线重连的 `refreshAfterReconnect` 也会强制回源。
 * 只在有内容时渲染：RUNNING=0 且 24h 内无任何活动（或查询失败/未就绪）整条隐藏、不占位。
 */

/** 「近期」窗口：与 `formatRelative` 退回绝对日期的 24h 阈值同口径。 */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 本地秒表：无 WS 事件时（如 Agent 长时间未回写）「N 分钟前」也随时间走。 */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function AgentStatusChip() {
  // page_size=1：只要 total（计数）与首条 updated_at（最近活动），不拉列表正文。
  const running = useTaskList({ status: ['RUNNING'], page_size: 1 });
  const runningCount = running.data?.total ?? 0;
  const runningSettled = running.data !== undefined;

  const latest = useTaskList({ page_size: 1 }, { enabled: runningSettled && runningCount === 0 });

  const now = useNow();
  const active = runningCount > 0;
  const lastActiveAt = (active ? running.data?.items[0]?.updated_at : latest.data?.items[0]?.updated_at) ?? null;
  const lastActiveMs = parseIso(lastActiveAt)?.getTime() ?? null;
  const recentText =
    lastActiveMs !== null && now - lastActiveMs <= RECENT_WINDOW_MS
      ? formatRelative(lastActiveAt, now)
      : null;

  // RUNNING=0 且拿不到 24h 内的活动（含还在加载/请求失败）→ 整条隐藏。
  if (!runningSettled) return null;
  if (!active && (latest.data === undefined || recentText === null)) return null;

  const title = active
    ? `当前 ${runningCount} 个任务执行中${lastActiveAt ? `，最近活动 ${formatDateTime(lastActiveAt)}` : ''}`
    : `当前无执行中任务，最近一次活动 ${formatDateTime(lastActiveAt)}`;

  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-badge border border-border bg-bg-muted px-2 py-0.5 text-badge text-text-secondary tabular-nums"
    >
      {active ? (
        <span className="inline-flex items-center gap-1.5">
          <span className={cn('size-1.5 rounded-full', STATUS_STYLE.RUNNING.dot)} aria-hidden />
          执行中 {runningCount}
        </span>
      ) : null}
      {recentText ? (
        <span
          className={cn('text-text-tertiary', active && 'border-l border-border pl-1.5')}
        >
          最近活动 {recentText}
        </span>
      ) : null}
    </span>
  );
}
