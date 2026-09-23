import type { ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { transitions } from '@/lib/motion';
import { IconButton } from './button';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** 抽屉头下方的固定区（Tab 条放这里，滚动区只包内容）。 */
  headerExtra?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * DESIGN.md §2 / motion-spec §1-L2：Radix Dialog 当右侧 sheet 用。入场从右滑入 x 100%→0，
 * ease-emphasis 260ms（transitions.drawer）；退场反向 180ms（transitions.drawerOut）；
 * 遮罩淡入随面板、淡出 140ms；圆角只落在左侧两角（rounded-l-drawer 16px）；
 * 宽度档 11.2：基础 480 / win-lg 560 / win-xl 640。Esc / 遮罩 / X 关闭与滚动锁定由 Radix 提供。
 * prefers-reduced-motion 时只做淡入淡出。
 */
export function Drawer({
  open,
  onClose,
  title,
  headerExtra,
  footer,
  children,
  className,
}: DrawerProps) {
  const reducedMotion = useReducedMotion();

  const sheetMotion = reducedMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, x: '100%' },
        animate: { opacity: 1, x: 0 },
        // 退场必须比入场快（§1-L2）：180ms（transitions.drawerOut），盖过组件级 drawer 档
        exit: { opacity: 0, x: '100%', transition: transitions.drawerOut },
      };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal forceMount>
        <AnimatePresence>
          {open ? (
            <DialogPrimitive.Overlay key="drawer-overlay" forceMount asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                // 遮罩淡入随面板（overlay 200ms）、淡出 140ms（§4.4）
                exit={{ opacity: 0, transition: transitions.exit }}
                transition={transitions.overlay}
                className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px] dark:bg-black/60"
              />
            </DialogPrimitive.Overlay>
          ) : null}
          {open ? (
            <DialogPrimitive.Content key="drawer-content" forceMount asChild aria-describedby={undefined}>
              <motion.aside
                {...sheetMotion}
                transition={transitions.drawer}
                className={cn(
                  'fixed right-0 top-0 z-40 flex h-full flex-col bg-bg-surface outline-none',
                  'w-[480px] win-lg:w-drawer-md win-xl:w-drawer',
                  'rounded-l-drawer shadow-drawer',
                  className,
                )}
              >
                <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
                  <DialogPrimitive.Title asChild>
                    <div className="min-w-0 flex-1 truncate text-section-title text-text-primary">
                      {title}
                    </div>
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Close asChild>
                    <IconButton label="关闭抽屉" icon={<X className="size-4" />} />
                  </DialogPrimitive.Close>
                </header>
                {headerExtra}
                <div data-selectable className="atb-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
                  {children}
                </div>
                {footer ? (
                  <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
                    {footer}
                  </footer>
                ) : null}
              </motion.aside>
            </DialogPrimitive.Content>
          ) : null}
        </AnimatePresence>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
