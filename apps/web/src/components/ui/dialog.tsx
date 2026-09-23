import type { ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { transitions } from '@/lib/motion';
import { IconButton } from './button';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** 弹窗宽度只有两档：表单 560px（1.5），审核表单 720px——同一组件的两个容器。 */
  size?: 'form' | 'review';
  footer?: ReactNode;
  children: ReactNode;
  /** 确认类弹窗默认给「取消」，表单类可关掉。 */
  dismissible?: boolean;
  className?: string;
}

/**
 * DESIGN.md §2 / motion-spec §1-L2：Radix Dialog + AnimatePresence。遮罩 bg-black/45 + 轻模糊（深色 /60）；
 * 面板入场 = 缩放 0.96→1 + 上移 8px + 淡入 200ms ease-emphasis（transitions.overlay），
 * 退场 = 同轨迹反向 140ms（transitions.exit）；遮罩淡入随面板、淡出 140ms。
 * Esc / 点击遮罩 / X 关闭、焦点圈定与滚动锁定全部由 Radix 提供。
 * prefers-reduced-motion 时只做淡入淡出。
 */
export function Dialog({
  open,
  onClose,
  title,
  size = 'form',
  footer,
  children,
  dismissible = true,
  className,
}: DialogProps) {
  const reducedMotion = useReducedMotion();

  const panelMotion = reducedMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, scale: 0.96, y: 8 },
        animate: { opacity: 1, scale: 1, y: 0 },
        // 退场同轨迹反向但更快：140ms（transitions.exit），盖过组件级 overlay 档
        exit: { opacity: 0, scale: 0.97, y: 4, transition: transitions.exit },
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
            <DialogPrimitive.Overlay key="dialog-overlay" forceMount asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                // 遮罩淡入随面板（overlay 200ms）、淡出 140ms（§4.4）
                exit={{ opacity: 0, transition: transitions.exit }}
                transition={transitions.overlay}
                className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] dark:bg-black/60"
              />
            </DialogPrimitive.Overlay>
          ) : null}
          {open ? (
            <DialogPrimitive.Content
              key="dialog-content"
              forceMount
              asChild
              // DismissableLayer 在 modal 下会给 Content 根元素内联 pointer-events:auto，
              // 这里用内联 style 覆盖回 none（其 style 合并顺序为 { computed, ...props.style }），保证暗区点击落回 Overlay 触发关闭
              style={{ pointerEvents: 'none' }}
              aria-describedby={undefined}
              aria-label={title === undefined ? '对话框' : undefined}
              onEscapeKeyDown={(event) => {
                if (!dismissible) event.preventDefault();
              }}
              onInteractOutside={(event) => {
                if (!dismissible) event.preventDefault();
              }}
            >
              <motion.div
                {...panelMotion}
                transition={transitions.overlay}
                // fit-content 绝对定位面板在 WKWebView 下 flex-1 滚动子项高度算 0，故用全屏居中层 + max-h-full 常规流；缩放动画打在全屏层，面板居中时视觉等价
                className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-6 outline-none"
              >
                <div
                  className={cn(
                    'pointer-events-auto flex max-h-full w-full flex-col overflow-hidden rounded-modal bg-bg-surface shadow-modal outline-none',
                    size === 'review' ? 'max-w-review-form' : 'max-w-dialog',
                    className,
                  )}
                >
                  {title !== undefined || dismissible ? (
                    <header className="flex h-11 shrink-0 items-center justify-between gap-4 border-b border-border px-5">
                      {title !== undefined ? (
                        <DialogPrimitive.Title asChild>
                          <h2 className="truncate text-section-title text-text-primary">{title}</h2>
                        </DialogPrimitive.Title>
                      ) : null}
                      {dismissible ? (
                        <DialogPrimitive.Close asChild>
                          <IconButton label="关闭" size="iconSm" icon={<X className="size-4" />} />
                        </DialogPrimitive.Close>
                      ) : null}
                    </header>
                  ) : null}
                  <div data-selectable className="atb-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
                    {children}
                  </div>
                  {footer ? (
                    <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-4">
                      {footer}
                    </footer>
                  ) : null}
                </div>
              </motion.div>
            </DialogPrimitive.Content>
          ) : null}
        </AnimatePresence>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
