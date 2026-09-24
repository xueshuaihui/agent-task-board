import { Fragment, useId, type ReactNode } from 'react';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/cn';
import { springs } from '@/lib/motion';

export interface RadioOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  description?: ReactNode;
  /**
   * 可选分组标题（0925 技能分类两级化）：与上一项 group 不同时，组前插一行
   * 不可选的标题（如「编码开发」下挂七个二级叶子），单选语义不变、仍是一个 RadioGroup。
   */
  group?: string;
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

/**
 * 设计改版（DESIGN.md §2）：Radix RadioGroup 封装，value/onValueChange 映射回
 * 旧签名 onChange(value)。选中圆点 springs.pop 微弹（scale 0→1，AnimatePresence 出场缩回）；
 * prefers-reduced-motion 下禁用弹出。键盘方向键切换由 Radix 提供。
 */
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
  const autoId = useId();
  const reducedMotion = useReducedMotion();
  return (
    <RadioGroupPrimitive.Root
      value={value}
      onValueChange={onChange}
      name={name ?? autoName}
      disabled={disabled}
      className={cn('flex gap-4', layout === 'column' ? 'flex-col' : 'flex-row flex-wrap', className)}
    >
      {options.map((option, index) => {
        const optionId = `${autoId}-${option.value}`;
        const selected = option.value === value;
        // 组头只在「本项带 group 且与上一项不同」时插一行（纯文案、不可选中）。
        const groupHeader =
          option.group && option.group !== options[index - 1]?.group ? option.group : null;
        return (
          <Fragment key={option.value}>
            {groupHeader ? (
              <span
                aria-hidden
                className="basis-full self-start text-aux font-medium text-text-tertiary"
              >
                {groupHeader}
              </span>
            ) : null}
            <label
              htmlFor={optionId}
              className={cn(
                'inline-flex cursor-pointer items-start gap-2 text-body',
                (option.disabled || disabled) && 'cursor-not-allowed opacity-50',
              )}
            >
              <RadioGroupPrimitive.Item
                id={optionId}
                value={option.value}
                disabled={option.disabled || disabled}
                className={cn(
                  'mt-[3px] flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-colors duration-140 ease-settle',
                  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  'data-[state=checked]:border-primary data-[state=checked]:bg-bg-surface',
                  'data-[state=unchecked]:border-border-strong data-[state=unchecked]:bg-bg-surface data-[state=unchecked]:hover:border-primary',
                )}
              >
                <AnimatePresence initial={false}>
                  {selected ? (
                    <motion.span
                      className="block size-2 rounded-full bg-primary"
                      initial={reducedMotion ? false : { scale: 0 }}
                      animate={{ scale: 1 }}
                      exit={reducedMotion ? undefined : { scale: 0 }}
                      transition={reducedMotion ? { duration: 0 } : springs.pop}
                    />
                  ) : null}
                </AnimatePresence>
              </RadioGroupPrimitive.Item>
              <span className="min-w-0">
                <span className="text-text-primary">{option.label}</span>
                {option.description ? (
                  <span className="block text-aux text-text-tertiary">{option.description}</span>
                ) : null}
              </span>
            </label>
          </Fragment>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}
