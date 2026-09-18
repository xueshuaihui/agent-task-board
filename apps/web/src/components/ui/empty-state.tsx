import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  /** 3.6 空态：无任务时给「新建任务」，带筛选时给「清除筛选」——两者不共存。 */
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-border px-6 py-8 text-center',
        className,
      )}
    >
      {icon ? <div className="text-text-tertiary">{icon}</div> : null}
      <p className="text-card-title text-text-secondary">{title}</p>
      {description ? <p className="max-w-[320px] text-aux text-text-secondary">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
