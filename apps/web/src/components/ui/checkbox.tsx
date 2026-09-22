import {
  forwardRef,
  useId,
  type ChangeEvent,
  type ComponentProps,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { motion, useReducedMotion } from 'motion/react';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { springs } from '@/lib/motion';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
  /** 表头全选只在当前页生效，部分选中要显示横杠（3.8）。 */
  indeterminate?: boolean;
  description?: ReactNode;
}

/**
 * Radix onCheckedChange → 旧的原生 onChange(event.target.checked)。
 * 业务页（task-list / board / settings）都按原生事件读 target.checked，
 * 这里合成最小事件对象保持签名不变。
 */
function toSyntheticChangeEvent(checked: boolean): ChangeEvent<HTMLInputElement> {
  return { type: 'change', target: { checked } } as unknown as ChangeEvent<HTMLInputElement>;
}

/**
 * 设计改版（DESIGN.md §2）：Radix 封装，勾选/横杠指示带 springs.pop 微弹（scale 0→1）；
 * prefers-reduced-motion 下禁用弹出（useReducedMotion → initial=false + 零时长）。
 * 颜色一律走 token；圆角 control 档里的 tag 6px。
 * 注意：ref 指向 Radix Root 渲染的 button 元素（原生 input 已不存在的语义变化）。
 */
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  { label, description, className, indeterminate = false, id, checked, disabled, onChange, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const reducedMotion = useReducedMotion();

  return (
    <label
      htmlFor={inputId}
      className={cn(
        'inline-flex cursor-pointer items-start gap-2 text-body',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <CheckboxPrimitive.Root
        ref={ref}
        id={inputId}
        checked={indeterminate ? 'indeterminate' : checked === undefined ? undefined : checked === true}
        onCheckedChange={(next) => onChange?.(toSyntheticChangeEvent(next === true))}
        disabled={disabled}
        className={cn(
          'inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-tag border transition-colors duration-140 ease-settle',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-text-inverse',
          'data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-text-inverse',
          'data-[state=unchecked]:border-border-strong data-[state=unchecked]:bg-bg-surface data-[state=unchecked]:hover:border-primary',
        )}
        {...(rest as ComponentProps<typeof CheckboxPrimitive.Root>)}
      >
        <CheckboxPrimitive.Indicator className="flex items-center justify-center">
          <motion.span
            className="flex items-center justify-center"
            initial={reducedMotion ? false : { scale: 0 }}
            animate={{ scale: 1 }}
            transition={reducedMotion ? { duration: 0 } : springs.pop}
          >
            {indeterminate ? <Minus className="size-3" /> : <Check className="size-3" />}
          </motion.span>
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
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
