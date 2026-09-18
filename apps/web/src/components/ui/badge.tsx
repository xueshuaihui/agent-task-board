import type { ReactNode } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/**
 * 1.3：标签胶囊圆角 `rounded-badge`（999px）；1.2：`text-badge` 12/18/500，数字/ID 叠 `tabular-nums`。
 * 状态/优先级色仍由调用方通过 `statusStyle()` / `priorityStyle()` 的 `soft` + `text` 类传入
 * （见 1.1 的 `bg-status-*-soft` / `bg-priority-*` token）——组件本身不内置第二套语义色。
 * 字号/字重落在内层文本节点上，避免与外观色的 `text-*` 工具类互斥。
 */
const badge = cva(
  'inline-flex max-w-full items-center gap-1 rounded-badge px-1.5 py-px tabular-nums',
  {
    variants: {
      tone: {
        neutral: 'bg-bg-muted text-text-secondary',
        soft: 'bg-bg-muted text-text-primary',
        outline: 'border border-border text-text-secondary',
      },
    },
    defaultVariants: { tone: 'soft' },
  },
);

export interface BadgeProps {
  children: ReactNode;
  className?: string;
  /** 图标位（📌 置顶、🔒 阻塞、色点）。 */
  icon?: ReactNode;
  tone?: 'neutral' | 'soft' | 'outline';
}

export function Badge({ children, className, icon, tone = 'soft' }: BadgeProps) {
  return (
    <span className={cn(badge({ tone }), className)}>
      {icon}
      <span className="truncate text-badge">{children}</span>
    </span>
  );
}

/** 状态色点（3.2 列头、3.8 状态列共用 8×8 圆点）。 */
export function StatusDot({ className }: { className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', className)} />;
}

/** 20.3 标签：卡片上最多 3 个、其余 `+N`（3.3），溢出交给调用方决定。 */
export function TagBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-tag bg-primary-light px-1.5 py-px text-primary">
      <span className="truncate text-badge">{children}</span>
    </span>
  );
}
