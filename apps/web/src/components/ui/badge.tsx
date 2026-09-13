import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * 1.4：标签圆角 4px；1.1：状态浅底 + 主色文本。
 * 状态/优先级色请配合 `statusStyle()` / `priorityStyle()` 传 className，
 * 组件本身不内置语义色——避免出现第二套配色。
 */
export interface BadgeProps {
  children: ReactNode;
  className?: string;
  /** 图标位（📌 置顶、🔒 阻塞、色点）。 */
  icon?: ReactNode;
  tone?: 'neutral' | 'soft' | 'outline';
}

export function Badge({ children, className, icon, tone = 'soft' }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-tag px-1.5 py-px text-badge',
        tone === 'neutral' && 'bg-bg-muted text-text-secondary',
        tone === 'soft' && 'bg-bg-muted text-text-primary',
        tone === 'outline' && 'border border-border text-text-secondary',
        className,
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
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
    <span className="inline-flex max-w-full items-center rounded-tag bg-primary-light px-1.5 py-px text-badge text-primary">
      <span className="truncate">{children}</span>
    </span>
  );
}
