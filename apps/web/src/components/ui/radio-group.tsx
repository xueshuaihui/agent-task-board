import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface RadioOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  description?: ReactNode;
}

export interface RadioGroupProps {
  value: string;
  options: readonly RadioOption[];
  onChange: (value: string) => void;
  /** 5.4 依赖类型、6.12.2 导入策略这类是「三选一」，竖排更好读。 */
  layout?: 'row' | 'column';
  name?: string;
  disabled?: boolean;
  className?: string;
}

export function RadioGroup({
  value,
  options,
  onChange,
  layout = 'row',
  name,
  disabled,
  className,
}: RadioGroupProps) {
  const autoName = useId();
  return (
    <div
      role="radiogroup"
      className={cn('flex gap-4', layout === 'column' ? 'flex-col' : 'flex-row flex-wrap', className)}
    >
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            'inline-flex cursor-pointer items-start gap-2 text-body',
            (option.disabled || disabled) && 'cursor-not-allowed opacity-50',
          )}
        >
          <input
            type="radio"
            name={name ?? autoName}
            value={option.value}
            checked={option.value === value}
            disabled={option.disabled || disabled}
            onChange={() => onChange(option.value)}
            className="mt-[6px] size-3.5 shrink-0 cursor-pointer appearance-none rounded-full border border-border-strong bg-bg-surface checked:border-primary checked:[box-shadow:inset_0_0_0_3px_var(--color-primary)] focus-visible:outline-2 focus-visible:outline-primary"
          />
          <span className="min-w-0">
            <span className="text-text-primary">{option.label}</span>
            {option.description ? (
              <span className="block text-aux text-text-tertiary">{option.description}</span>
            ) : null}
          </span>
        </label>
      ))}
    </div>
  );
}
