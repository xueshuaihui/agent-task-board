import { cn } from '@/lib/cn';

/**
 * 平铺多选按钮组（chip group）：静态样式对齐看板工具栏段控件口径
 * （h-7 rounded-control text-body，选中态语义 token），不加任何
 * transition/duration 类（动效统一走另一分支）。
 */

export interface ChipGroupOption {
  value: string;
  label: string;
  /** 可选计数徽标（如命中条数）。 */
  count?: number;
}

export interface ChipGroupProps {
  options: readonly ChipGroupOption[];
  /** 已选 value 集合；多选为 OR 语义，由调用方解释。 */
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  /** 组前缀文案（如「分类」），与段控件的视图标签同款式。 */
  label?: string;
  /** 无障碍名称；缺省时回退到 label。 */
  'aria-label'?: string;
  className?: string;
}

export function ChipGroup({ options, selected, onChange, label, className, ...props }: ChipGroupProps) {
  const ariaLabel = props['aria-label'] ?? label;
  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  };
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn('flex flex-wrap items-center gap-1', className)}
    >
      {label ? <span className="mr-1 shrink-0 text-aux text-text-tertiary">{label}</span> : null}
      {options.map((option) => {
        const active = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => toggle(option.value)}
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1 rounded-control border px-2 text-body',
              active
                ? 'border-primary bg-primary-light text-primary'
                : 'border-border text-text-secondary hover:bg-bg-muted hover:text-text-primary',
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <span
                className={cn(
                  'rounded-badge px-1 text-badge tabular-nums',
                  active ? 'bg-primary text-text-inverse' : 'bg-bg-muted text-text-tertiary',
                )}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
