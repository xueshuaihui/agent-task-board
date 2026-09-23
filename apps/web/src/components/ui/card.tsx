import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** 1.4：卡片默认 `shadow-card`，悬停 `shadow-card-hover`（motion-spec §1-L1：140ms ease-settle）。 */
  hoverable?: boolean;
}

export function Card({ className, hoverable, children, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-card border border-border bg-bg-surface shadow-card',
        hoverable && 'transition-shadow duration-140 ease-settle hover:shadow-card-hover',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex h-11 items-center gap-2 border-b border-border px-4 text-section-title text-text-primary',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('p-4', className)}>{children}</div>;
}
