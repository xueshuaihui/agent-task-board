import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
  /** 表头全选只在当前页生效，部分选中要显示横杠（3.8）。 */
  indeterminate?: boolean;
  description?: ReactNode;
}

/**
 * 视觉自绘、交互仍用原生 input：`indeterminate` 在原生控件上各 WebView 长相不一，
 * 但键盘空格、表单语义、点击热区都得靠它，所以 input 只是被盖住而不是被换掉。
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, className, indeterminate = false, id, checked, disabled, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const active = Boolean(checked) || indeterminate;
  return (
    <label
      htmlFor={inputId}
      className={cn(
        'inline-flex cursor-pointer items-start gap-2 text-body',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          className="peer absolute inset-0 size-4 cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
          {...rest}
        />
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 flex items-center justify-center rounded-tag border transition-colors duration-120 ease-out',
            'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-primary',
            active
              ? 'border-primary bg-primary text-text-inverse'
              : 'border-border-strong bg-bg-surface',
          )}
        >
          {indeterminate ? (
            <Minus className="size-3" />
          ) : checked ? (
            <Check className="size-3" />
          ) : null}
        </span>
      </span>
      {label ? (
        <span className="min-w-0">
          <span className="text-text-primary">{label}</span>
          {description ? (
            <span className="block text-aux text-text-tertiary">{description}</span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
});
