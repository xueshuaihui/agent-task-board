import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * 1.5 按钮高度：主 32px（h-8）、小 28px（h-7）；1.3 圆角 control 8px。
 * `variant` 覆盖交互语义：primary=主操作（审核通过）、danger=不可逆（删除/强制停止）。
 *
 * 设计改版（DESIGN.md §2 / §0）：多 variant 用 cva 组合；primary 走 .bg-primary-gradient
 * 靛蓝→紫渐变 + .shadow-primary-inset 顶缘内高光（玻璃厚度）；按压 active:scale-[.98]。
 * 颜色一律走 token，不硬编码 hex。
 */
const button = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-medium transition-[background-color,color,box-shadow,transform] duration-140 ease-settle active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
  {
    variants: {
      variant: {
        primary: 'bg-primary-gradient shadow-primary-inset text-text-inverse hover:opacity-95',
        default:
          'bg-bg-surface text-text-primary border border-border hover:bg-bg-muted',
        ghost: 'text-text-secondary hover:bg-bg-muted hover:text-text-primary',
        danger: 'bg-status-failed text-text-inverse hover:opacity-90',
        outlineDanger:
          'border border-status-failed text-status-failed hover:bg-status-failed-soft',
        subtle: 'bg-bg-muted text-text-primary hover:bg-border',
      },
      size: {
        md: 'h-8 px-3 text-body',
        sm: 'h-7 px-2 gap-1.5 text-aux',
        icon: 'h-8 w-8',
        iconSm: 'h-7 w-7',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
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
      className={cn(button({ variant, size }), className)}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

/** 顶栏与卡片 `⋯` 里的纯图标按钮（铃铛 24×24 也用它做底子）。必须转发 ref：radix 的 Trigger asChild 要靠它定位浮层。 */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonProps & { label: string }
>(function IconButton({ label, className, ...props }, ref) {
  return (
    <Button
      ref={ref}
      size="icon"
      variant="ghost"
      aria-label={label}
      title={label}
      className={cn('rounded-full', className)}
      {...props}
    />
  );
});
