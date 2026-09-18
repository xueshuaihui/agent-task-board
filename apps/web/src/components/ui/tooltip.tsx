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
 */
export function Tooltip({ content, children, side = 'top', className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const reducedMotion = useReducedMotion();

  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root open={open} onOpenChange={setOpen} delayDuration={300}>
        <TooltipPrimitive.Trigger asChild>
          <span className="inline-flex min-w-0">{children}</span>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal forceMount>
          <AnimatePresence>
            {open ? (
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
            ) : null}
          </AnimatePresence>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
