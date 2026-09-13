import { useEffect, useState } from 'react';
import { Lock, Pin } from 'lucide-react';
import type { TaskListItem } from '@/api/types';
import { Badge, StatusDot, Tooltip, MonoCell } from '@/components/ui';
import { PRIORITY_LABEL, priorityLabel, priorityText, statusLabel } from '@/lib/labels';
import { priorityStyle, statusStyle } from '@/lib/status-style';
import { formatDuration, formatDateTime, formatRelative, leaseRemaining } from '@/lib/time';

/**
 * 3.8 表格的单元格：列宽按原型逐列给（ID 90 / 类型 88 / 优先级 64 / 状态 96 /
 * 标签 160 / Agent 104 / 时长 72 / 更新时间 104）。
 *
 * 审核页的待审核表格复用这一组单元格的语义（同一套色点 + 中文名的列，3.8 与 8.4 的
 * 表格在视觉上必须一致），所以 `features/review` 会从这里 import。
 */

/** 租约倒计时由前端本地时钟相减得出（20.4），所以整页共用一个秒级 tick。 */
export function useNowTick(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // 页面上没有 RUNNING 行时不装定时器：整表每秒重渲染一次毫无收益。
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

/** 3.8：`archived_at` 非空追加灰色「已归档」徽标。 */
export function isArchivedRow(row: TaskListItem): boolean {
  return Boolean(row.archived_at);
}

/**
 * 3.8 时长列：最近一次 Run 的 `duration_ms`，RUNNING 换成「已进行时间」——
 * 那条 Run 还没结束，`duration_ms` 是 null，只能由 `started_at` 与整页 tick 相减得出。
 */
export function displayedDurationMs(row: TaskListItem, now: number): number | null {
  if (row.status !== 'RUNNING' || !row.started_at) return row.duration_ms;
  const started = Date.parse(row.started_at);
  return Number.isNaN(started) ? row.duration_ms : Math.max(0, now - started);
}

export function IdCell({ id }: { id: string }) {
  return <MonoCell>{id}</MonoCell>;
}

/** 3.8：单行省略 + hover 全文；📌 置顶、🔒 有未满足前置。 */
export function TitleCell({ row }: { row: TaskListItem }) {
  const markers = (
    <>
      {row.pinned ? (
        <Pin
          className="size-3.5 shrink-0 text-status-pinned"
          aria-label="已置顶"
          data-testid="pin"
        />
      ) : null}
      {row.blocked.count > 0 ? (
        <Tooltip content={blockedText(row)}>
          <Lock className="size-3.5 shrink-0 text-status-blocked" aria-label="被前置阻塞" />
        </Tooltip>
      ) : null}
    </>
  );
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {markers}
      <Tooltip content={row.title}>
        <span className="block min-w-0 truncate text-text-primary" title={row.title}>
          {row.title}
        </span>
      </Tooltip>
    </span>
  );
}

function blockedText(row: TaskListItem): string {
  const names = row.blocked.by.map((item) => `${item.id} ${item.title}`).join('、');
  const more = row.blocked.count > row.blocked.by.length ? ` 等 ${row.blocked.count} 个` : '';
  return `被 ${row.blocked.count} 个前置阻塞：${names}${more}`;
}

export function TypeCell({ row }: { row: TaskListItem }) {
  // 20.3：词表已删也照样显示原值，所以这里不做任何映射。
  return <span className="block truncate text-text-secondary">{row.type}</span>;
}

export function PriorityCell({ priority }: { priority: number }) {
  const style = priorityStyle(priority);
  // 20.11：表外优先级不能伪装成 `P5`——`priorityLabel` 已经把它算成「未知（P5）」，
  // 这里只在四个已知值上保留 3.8 的紧凑写法（`P1`），中文名列宽 64px 放不下，走 Tooltip。
  const knownLabel = (PRIORITY_LABEL as Partial<Record<0 | 1 | 2 | 3, string>>)[priority as 0 | 1 | 2 | 3];
  const text = knownLabel ? `P${priority}` : priorityLabel(priority);
  return (
    <Tooltip content={priorityText(priority)}>
      <span className={`inline-flex max-w-full items-center gap-1.5 ${style.text}`}>
        <StatusDot className={style.dot} />
        <span className="truncate text-aux">{text}</span>
      </span>
    </Tooltip>
  );
}

/** 3.8：六态色点 + 中文名；RUNNING 追加租约倒计时；归档行追加徽标。 */
export function StatusCell({ row, archivedShown, now }: { row: TaskListItem; archivedShown: boolean; now: number }) {
  const style = statusStyle(row.status);
  const lease =
    row.status === 'RUNNING' && row.lease_expires_at ? leaseRemaining(row.lease_expires_at, now) : null;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <StatusDot className={style.dot} />
      <span className="text-text-primary">{row.status_label || statusLabel(row.status)}</span>
      {lease ? (
        <span
          className={
            lease.expired ? 'text-aux text-status-failed' : 'text-aux font-mono text-text-tertiary'
          }
        >
          {lease.text}
        </span>
      ) : null}
      {archivedShown || isArchivedRow(row) ? (
        <Badge tone="neutral" className="shrink-0">
          已归档
        </Badge>
      ) : null}
    </span>
  );
}

/** 3.3 / 3.8：标签最多 3 个，其余 `+N`。 */
export function TagsCell({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return <span className="text-aux text-text-tertiary">—</span>;
  const shown = tags.slice(0, 3);
  const rest = tags.slice(3);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {shown.map((tag) => (
        <Badge key={tag} tone="outline">
          {tag}
        </Badge>
      ))}
      {rest.length > 0 ? (
        <Tooltip content={rest.join('、')}>
          <span className="text-aux text-text-tertiary">+{rest.length}</span>
        </Tooltip>
      ) : null}
    </span>
  );
}

export function AgentCell({ row }: { row: TaskListItem }) {
  return row.agent_name ? (
    <span className="block truncate text-text-secondary" title={row.agent_name}>
      {row.agent_name}
    </span>
  ) : (
    <span className="text-aux text-text-tertiary">—</span>
  );
}

export function DurationCell({ ms }: { ms: number | null }) {
  return <span className="text-aux text-text-secondary">{formatDuration(ms)}</span>;
}

/** 20.4：24 小时内相对时间，hover 绝对时间。 */
export function UpdatedCell({ value }: { value: string | null }) {
  return (
    <Tooltip content={formatDateTime(value)}>
      <span className="block truncate text-aux text-text-secondary">{formatRelative(value)}</span>
    </Tooltip>
  );
}
