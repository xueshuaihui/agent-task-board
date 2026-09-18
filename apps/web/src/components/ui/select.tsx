import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: readonly SelectOption[];
  /** 空值占位（不选任何项时给 `''`）。 */
  placeholder?: string;
  invalid?: boolean;
}

/** 1.1：raised 底 + focus ring（primary-ring）；全局 :focus-visible 也会补描边。 */
const selectClass = cn(
  'h-8 w-full appearance-none rounded-control border border-border bg-bg-raised px-3 pr-8 text-body text-text-primary',
  'transition-colors duration-120 ease-out',
  'hover:border-border-strong',
  'focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-ring',
  'disabled:cursor-not-allowed disabled:opacity-60',
  'aria-[invalid=true]:border-status-failed',
);

/**
 * 用原生 `<select>` 而不是自绘下拉（DESIGN.md §2）：桌面 WebView 里原生面板
 * 键盘/IME 体验最好，这里只换皮——raised 底、focus ring、右侧自绘箭头。
 * 需要「多选 + 搜索」的场合用 Menu + Checkbox。
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, options, placeholder, invalid, ...rest },
  ref,
) {
  return (
    <span className="relative inline-flex w-full items-center">
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(selectClass, className)}
        {...rest}
      >
        {placeholder === undefined ? null : (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 size-4 text-text-tertiary" />
    </span>
  );
});
