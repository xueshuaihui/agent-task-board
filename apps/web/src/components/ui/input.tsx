import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/** 1.5：输入框高 32px、圆角 6px；1.1：底 `--bg-muted`、边框 `--border`。 */
export const inputClass = cn(
  'h-8 w-full rounded-control border border-border bg-bg-muted px-3 text-body text-text-primary',
  'placeholder:text-text-tertiary transition-colors duration-120 ease-out',
  'focus:border-primary focus:bg-bg-surface focus:outline-none',
  'disabled:cursor-not-allowed disabled:opacity-60',
  'aria-[invalid=true]:border-status-failed',
);

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(inputClass, className)}
      {...rest}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

/** 描述与审核三字段用：去掉固定高度，其余与 Input 同套 token。 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, rows = 3, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      data-selectable
      className={cn(inputClass, 'h-auto py-2 leading-[var(--text-body--line-height)]', className)}
      {...rest}
    />
  );
});
