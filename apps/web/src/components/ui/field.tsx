import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface FieldProps {
  label: ReactNode;
  /** 20.10：必填字段缺失时后端给 422，界面先把星号画出来。 */
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

/** 表单行的统一壳：标签 + 控件 + 提示/错误。错误优先于提示（同一行不显示两行小字）。 */
export function Field({ label, required, hint, error, htmlFor, className, children }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="text-card-title text-text-primary">
        {label}
        {required ? <span className="ml-1 text-status-failed">*</span> : null}
      </label>
      {children}
      {error ? (
        <p className="text-aux text-status-failed">{error}</p>
      ) : hint ? (
        <p className="text-aux text-text-tertiary">{hint}</p>
      ) : null}
    </div>
  );
}
