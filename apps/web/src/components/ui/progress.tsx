import { cn } from '@/lib/cn';

export interface ProgressProps {
  /** `null` = 从未上报进度，此时**整条不渲染**（原型 3.3、20.2）。 */
  value: number | null | undefined;
  className?: string;
  /** 租约过期时进度条转红（3.3 的倒计时同变红）。 */
  danger?: boolean;
}

/** 20.4：`progress` 是整数百分比，禁止小数——这里也不做插值。 */
export function Progress({ value, className, danger }: ProgressProps) {
  if (value === null || value === undefined) return null;
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('h-1 w-full overflow-hidden rounded-badge bg-bg-muted', className)}
    >
      <div
        className={cn(
          'h-full rounded-badge transition-[width] duration-200 ease-settle',
          danger ? 'bg-status-failed' : 'bg-status-running',
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
