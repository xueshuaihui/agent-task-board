import { useId, type ReactNode } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/cn';
import { springs } from '@/lib/motion';

export interface TabItem {
  value: string;
  label: ReactNode;
  /** 4.5 / 20.7：计数徽标（列头计数、Tab 上的条数）。 */
  count?: number;
  disabled?: boolean;
}

export interface TabsProps {
  value: string;
  onChange: (value: string) => void;
  items: readonly TabItem[];
  /**
   * `segmented` = 3.4 的视图预设（全部/待我审核/可领取/已阻塞/异常）；
   * `underline` = 4.2 抽屉 Tab 与 2.2 顶栏导航那套下划线。
   */
  variant?: 'segmented' | 'underline';
  /**
   * 合并到 `List`（border/px 等行级类都写在 List 上，44 走查：此前只给 Root，
   * 调用方 `border-b-0 px-0` 覆盖不到 List 的 `border-b px-5`，完全不生效）。
   */
  className?: string;
  ariaLabel?: string;
}

/**
 * Tabs（DESIGN.md §2）：Radix Tabs 提供方向键/roving focus/aria，motion
 * `layoutId` 做滑动指示器——segmented 滑动胶囊（primary-light 底）、underline
 * 滑动 2px 下划线，切换时指示器用 springs.gentle 滑过去。layoutId 按实例生成，
 * 避免同屏多个 Tabs 互相串场。
 */
export function Tabs({
  value,
  onChange,
  items,
  variant = 'segmented',
  className,
  ariaLabel,
}: TabsProps) {
  const indicatorId = useId();
  const reduceMotion = useReducedMotion();
  const indicatorTransition = reduceMotion ? { duration: 0 } : springs.gentle;

  return (
    /* Root 只做 min-w-0：它在抽屉头/工具栏里常是 flex item，若不收缩则 List 的
       overflow-x 滚动永远不触发、页签照旧被挤扁（44 走查）。行级覆盖类见
       TabsProps.className——改合并到 List。 */
    <TabsPrimitive.Root value={value} onValueChange={onChange} className="min-w-0">
      {variant === 'underline' ? (
        <TabsPrimitive.List
          aria-label={ariaLabel}
          className={cn(
            // pb-px：overflow-x-auto 会按 padding box 裁切，不留这 1px 的话
            // Trigger 里 -bottom-px 的指示器下沿会被裁掉半像素。
            'atb-scroll flex min-w-0 items-center gap-6 overflow-x-auto border-b border-border px-5 pb-px',
            className,
          )}
        >
          {items.map((item) => {
            const active = item.value === value;
            return (
              <TabsPrimitive.Trigger
                key={item.value}
                value={item.value}
                disabled={item.disabled}
                className={cn(
                  // shrink-0 + whitespace-nowrap：窄容器下中文标签会被逐字竖排断行
                  'relative flex h-11 shrink-0 items-center gap-1 whitespace-nowrap rounded-none text-nav outline-none transition-colors duration-120 ease-out',
                  active ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary',
                  item.disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                {active ? (
                  <motion.span
                    layoutId={indicatorId}
                    transition={indicatorTransition}
                    className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary"
                  />
                ) : null}
                <span className="relative flex items-center gap-1">
                  {item.label}
                  {item.count !== undefined ? <CountBadge count={item.count} muted /> : null}
                </span>
              </TabsPrimitive.Trigger>
            );
          })}
        </TabsPrimitive.List>
      ) : (
        <TabsPrimitive.List
          aria-label={ariaLabel}
          className={cn('inline-flex h-8 items-center gap-1 rounded-control bg-bg-muted p-1', className)}
        >
          {items.map((item) => {
            const active = item.value === value;
            return (
              <TabsPrimitive.Trigger
                key={item.value}
                value={item.value}
                disabled={item.disabled}
                className={cn(
                  'relative flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-[4px] px-2 text-aux outline-none transition-colors duration-120 ease-out',
                  active ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary',
                  item.disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                {active ? (
                  <motion.span
                    layoutId={indicatorId}
                    transition={indicatorTransition}
                    className="absolute inset-0 rounded-[4px] bg-primary-light"
                  />
                ) : null}
                <span className="relative flex items-center gap-1">
                  {item.label}
                  {item.count !== undefined ? <CountBadge count={item.count} /> : null}
                </span>
              </TabsPrimitive.Trigger>
            );
          })}
        </TabsPrimitive.List>
      )}
    </TabsPrimitive.Root>
  );
}

function CountBadge({ count, muted }: { count: number; muted?: boolean }) {
  return (
    <span
      className={cn(
        'min-w-[18px] rounded-badge px-1.5 py-px text-center text-badge tabular-nums',
        muted ? 'bg-bg-muted text-text-secondary' : 'bg-bg-surface text-text-secondary',
      )}
    >
      {count}
    </span>
  );
}
