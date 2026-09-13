import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { inputClass } from './input';

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

/**
 * 用原生 `<select>` 而不是自绘下拉：桌面 WebView 里原生面板体验已经够好，
 * 且键盘/IME 行为不需要我们重新实现一遍。需要「多选 + 搜索」的场合用 Menu + Checkbox。
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
        className={cn(inputClass, 'appearance-none pr-8', className)}
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
