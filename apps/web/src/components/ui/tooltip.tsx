import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/cn';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  /** 3.8「更新时间」列：hover 看绝对时间。默认在上方，靠窗口边缘时 Radix 自动翻转。 */
  side?: 'top' | 'bottom';
  className?: string;
}

/**
 * DESIGN.md §2：Radix Tooltip，延迟 300ms，深色底胶囊 + 小箭头，出入淡入 + 轻微上浮
 * （y 4→0，120ms）。深色底沿用 token 组合 `bg-text-primary` + `text-text-inverse`
 * （DESIGN.md §2「深色底胶囊」），箭头同色。受控 open 以便 AnimatePresence 播退场。
 * prefers-reduced-motion 时只做淡入淡出。
 *
 * 嵌套顺序 = **AnimatePresence 在外、`Portal forceMount` 在内**（Dialog / Drawer / Popover / Menu 同构，
 * motion-spec §4.3）。不能反过来写的原因：Radix 的 TooltipPortal 内部渲染的是
 * `<Presence present><Portal asChild>{children}</Portal></Presence>`，那个 `asChild` 走
 * @radix-ui/react-slot——Slot 把 Presence 合成的 ref 用 `cloneElement(child, { ref })` 转给自己的
 * 唯一子节点。子节点若是 `<AnimatePresence>`（motion 13 里是普通函数组件、无 forwardRef），
 * React 18 就报「Function components cannot be given refs … Check the render method of
 * `Primitive.div.Slot`」——纯挂载即报（forceMount 让 Presence/Portal 常驻，与 open 无关），
 * 且 ref 落空 ⇒ Radix Presence 拿不到 DOM 节点。挪到 Portal 之外后，ref 链经 Content（forwardRef）
 * 一路落到 motion.span 这个真实节点上。Portal 与 Content 的 forceMount 均保留 ⇒ Presence 的
 * present 恒 true，退场不会被 Radix 提前卸载，何时卸载仍由 AnimatePresence 决定。
 */
export function Tooltip({ content, children, side = 'top', className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const reducedMotion = useReducedMotion();

  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root open={open} onOpenChange={setOpen} delayDuration={300}>
        <TooltipPrimitive.Trigger asChild>
          <span className="inline-flex min-w-0 shrink-0">{children}</span>
        </TooltipPrimitive.Trigger>
        <AnimatePresence>
          {open ? (
            <TooltipPrimitive.Portal forceMount>
              <TooltipPrimitive.Content
                key="tooltip-content"
                forceMount
                side={side}
                sideOffset={4}
                collisionPadding={8}
                asChild
              >
                <motion.span
                  initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                  animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.1, ease: 'easeOut' } }}
                  transition={{ duration: 0.12, ease: 'easeOut' }}
                  className={cn(
                    'z-[70] max-w-[280px] truncate rounded-control bg-text-primary px-2 py-1 text-aux text-text-inverse shadow-card-hover',
                    className,
                  )}
                >
                  {content}
                  <TooltipPrimitive.Arrow className="fill-text-primary" />
                </motion.span>
              </TooltipPrimitive.Content>
            </TooltipPrimitive.Portal>
          ) : null}
        </AnimatePresence>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
