import { cn } from '@/lib/cn';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}

/** 20.9 的布尔设置项（如 `review_reuse_last_opinion`）。尺寸仍走 32px 控件档。 */
export function Switch({ checked, onChange, disabled, label, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex h-8 w-12 shrink-0 items-center rounded-full border px-1 transition-colors duration-120 ease-out',
        checked ? 'border-primary bg-primary' : 'border-border-strong bg-bg-muted',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <span
        className={cn(
          'size-6 rounded-full bg-bg-surface shadow-card transition-transform duration-120 ease-out',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  );
}
