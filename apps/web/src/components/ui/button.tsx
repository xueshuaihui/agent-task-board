import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * 1.5 按钮高度：主 32px（h-8）、小 28px（h-7）；1.4 圆角 6px、无阴影。
 * `variant` 覆盖 4.5 的交互语义：primary=主操作（审核通过）、danger=不可逆（删除/强制停止）。
 */
const VARIANTS = {
  primary:
    'bg-primary text-text-inverse hover:bg-primary-hover disabled:hover:bg-primary',
  default:
    'bg-bg-surface text-text-primary border border-border hover:bg-bg-muted disabled:hover:bg-bg-surface',
  ghost: 'text-text-secondary hover:bg-bg-muted hover:text-text-primary',
  danger: 'bg-status-failed text-text-inverse hover:opacity-90',
  outlineDanger:
    'border border-status-failed text-status-failed hover:bg-status-failed-soft',
  subtle: 'bg-bg-muted text-text-primary hover:bg-border',
} as const;

const SIZES = {
  md: 'h-8 px-3 gap-2 text-body',
  sm: 'h-7 px-2 gap-1.5 text-aux',
  icon: 'h-8 w-8 justify-center',
  iconSm: 'h-7 w-7 justify-center',
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', loading = false, icon, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center rounded-control font-medium transition-colors duration-120 ease-out',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

/** 顶栏与卡片 `⋯` 里的纯图标按钮（2.2 铃铛 24×24 也用它做底子）。 */
export function IconButton({
  label,
  className,
  ...props
}: ButtonProps & { label: string }) {
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={label}
      title={label}
      className={cn('rounded-full', className)}
      {...props}
    />
  );
}
