import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/cn';
import { BREAKDOWN_STATUS_LABEL, type BreakdownSessionStatus } from '@/api/types';
import { StatusDot } from '@/components/ui';
import { BREAKDOWN_STATUS_STYLE } from './status-meta';

/** §7.7 六态徽标：色点 + 中文名，色板走 `status-meta.ts` 的 1.1 token 映射。 */
export function BreakdownStatusBadge({
  status,
  className,
}: {
  status: BreakdownSessionStatus;
  className?: string;
}) {
  const style = BREAKDOWN_STATUS_STYLE[status] ?? BREAKDOWN_STATUS_STYLE.interrupted;
  return (
    <span
      data-testid="breakdown-status-badge"
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-badge px-1.5 py-px text-badge',
        style.soft,
        style.text,
        className,
      )}
    >
      <StatusDot className={style.dot} />
      {BREAKDOWN_STATUS_LABEL[status] ?? status}
    </span>
  );
}

/**
 * §7.3 会话切换器（阶段 2「多会话并发」）：按到达时间排序、进行中会话带红点；
 * 当前会话描边。切换只换 `activeId`，不关闭覆盖层。
 */
export interface SessionSwitcherProps {
  sessions: { id: string; parent_title: string; status: BreakdownSessionStatus }[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

export function SessionSwitcher({ sessions, activeId, onSelect }: SessionSwitcherProps) {
  const reduced = useReducedMotion();
  if (sessions.length === 0) return null;
  return (
    <div
      role="tablist"
      aria-label="拆解会话切换器"
      className="flex items-center gap-1.5 overflow-x-auto border-b border-border px-4 py-2"
      data-testid="breakdown-session-switcher"
    >
      {sessions.map((session) => {
        const active = session.id === activeId;
        return (
          <motion.button
            key={session.id}
            type="button"
            role="tab"
            aria-selected={active}
            whileHover={reduced ? undefined : { y: -1 }}
            onClick={() => onSelect(session.id)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-control border px-2 py-1 text-aux transition-colors',
              active
                ? 'border-primary bg-primary-light text-primary'
                : 'border-border bg-bg-surface text-text-secondary hover:bg-bg-muted',
            )}
          >
            {/* 进行中会话红点（§7.3）：待确认/接收中/创建中都算。 */}
            {(session.status === 'receiving' ||
              session.status === 'reviewing' ||
              session.status === 'creating') && (
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-failed" />
            )}
            <span className="max-w-[160px] truncate">{session.parent_title}</span>
            <BreakdownStatusBadge status={session.status} />
          </motion.button>
        );
      })}
    </div>
  );
}
