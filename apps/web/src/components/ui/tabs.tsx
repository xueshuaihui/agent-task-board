import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem {
  value: string;
  label: ReactNode;
  /** 4.5 / 20.7：计数徽标（列头计数、Tab 上的条数）。 */
  count?: number;
  disabled?: boolean;
}

export interface TabsProps {
  value: string;
  onChange: (value: string) => void;
  items: readonly TabItem[];
  /**
   * `segmented` = 3.4 的视图预设（全部/待我审核/可领取/已阻塞/异常）；
   * `underline` = 4.2 抽屉 Tab 与 2.2 顶栏导航那套下划线。
   */
  variant?: 'segmented' | 'underline';
  className?: string;
  ariaLabel?: string;
}

export function Tabs({
  value,
  onChange,
  items,
  variant = 'segmented',
  className,
  ariaLabel,
}: TabsProps) {
  if (variant === 'underline') {
    return (
      <div
        role="tablist"
        aria-label={ariaLabel}
        className={cn('flex items-center gap-6 border-b border-border px-5', className)}
      >
        {items.map((item) => (
          <button
            key={item.value}
            role="tab"
            type="button"
            aria-selected={item.value === value}
            disabled={item.disabled}
            onClick={() => onChange(item.value)}
            className={cn(
              '-mb-px flex h-11 items-center gap-1 border-b-2 text-nav transition-colors duration-120 ease-out',
              item.value === value
                ? 'border-primary text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary',
              item.disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {item.label}
            {item.count !== undefined ? <CountBadge count={item.count} muted /> : null}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('inline-flex h-8 items-center gap-1 rounded-control bg-bg-muted p-1', className)}
    >
      {items.map((item) => (
        <button
          key={item.value}
          role="tab"
          type="button"
          aria-selected={item.value === value}
          disabled={item.disabled}
          onClick={() => onChange(item.value)}
          className={cn(
            'flex h-6 items-center gap-1 rounded-[4px] px-2 text-aux transition-colors duration-120 ease-out',
            item.value === value
              ? 'bg-bg-surface text-primary shadow-card'
              : 'text-text-secondary hover:text-text-primary',
            item.disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          {item.label}
          {item.count !== undefined ? <CountBadge count={item.count} /> : null}
        </button>
      ))}
    </div>
  );
}

function CountBadge({ count, muted }: { count: number; muted?: boolean }) {
  return (
    <span
      className={cn(
        'min-w-[18px] rounded-badge px-1.5 py-px text-center text-badge',
        muted ? 'bg-bg-muted text-text-secondary' : 'bg-bg-surface text-text-secondary',
      )}
    >
      {count}
    </span>
  );
}
