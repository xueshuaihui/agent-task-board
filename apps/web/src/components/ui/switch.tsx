import * as SwitchPrimitive from '@radix-ui/react-switch';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/cn';
import { springs } from '@/lib/motion';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}

/**
 * 设计改版（DESIGN.md §2）：Radix Switch 封装，onCheckedChange 映射回旧签名
 * onChange(boolean)。轨道 bg-bg-muted → bg-primary，滑块 bg-bg-surface + shadow-card；
 * 滑动用 springs.snappy，切换瞬间滑块以 springs.pop 微弹（scale 0→1）；
 * prefers-reduced-motion 下两段动效都禁用（useReducedMotion → initial=false + 零时长）。
 * 尺寸仍走 32px 控件档（h-8 w-12，滑块 24px、行程 16px）。
 */
export function Switch({ checked, onChange, disabled, label, className }: SwitchProps) {
  const reducedMotion = useReducedMotion();
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={(next) => onChange(next === true)}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'relative inline-flex h-8 w-12 shrink-0 items-center rounded-full px-1 transition-colors duration-120 ease-out',
        checked ? 'bg-primary' : 'bg-bg-muted',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <SwitchPrimitive.Thumb asChild>
        <motion.span
          className="block size-6 rounded-full bg-bg-surface shadow-card"
          animate={{ x: checked ? 16 : 0 }}
          transition={reducedMotion ? { duration: 0 } : springs.snappy}
        >
          <motion.span
            key={checked ? 'on' : 'off'}
            className="block size-full rounded-full bg-bg-surface"
            initial={reducedMotion ? false : { scale: 0 }}
            animate={{ scale: 1 }}
            transition={reducedMotion ? { duration: 0 } : springs.pop}
          />
        </motion.span>
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  );
}
