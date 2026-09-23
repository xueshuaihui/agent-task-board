import { type ReactNode } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/cn';
import { transitions } from '@/lib/motion';

type ContentProps = PopoverPrimitive.PopoverContentProps;

export interface PopoverProps {
  /** 全受控（本仓 render-prop/受控触发器习惯，对齐 menu.tsx）：开关时机完全由调用方决定，
   * 组件不内置 Trigger 交互——如全局搜索的「聚焦 + 有查询词」态。 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 定位锚点：调用方给的触发元素，挂 `<PopoverAnchor asChild>`（需可挂 ref）。 */
  anchor?: ReactNode;
  /** 浮层内容（渲染进 Portal + motion 容器）。 */
  children: ReactNode;
  side?: 'top' | 'bottom';
  sideOffset?: number;
  /** 默认 start：搜索结果/筛选面板这类「对齐锚点左缘」的用法占多数。 */
  align?: 'start' | 'center' | 'end';
  /** 面板宽度：'trigger' = 与锚点同宽（--radix-popover-trigger-width），数字按 px、字符串原样作 CSS 宽度。 */
  contentWidth?: 'trigger' | number | string;
  /** 默认 true：onOpenAutoFocus preventDefault，焦点留在调用方输入框（combobox 模式硬需求）；
   * 传 false 交还 Radix 默认（焦点进层）。 */
  preventOpenAutoFocus?: boolean;
  /** Radix 事件透传：业务在 handler 里 preventDefault 即跳过对应 dismiss——
   * 如「点锚点自身不收下拉」「Esc 交还调用方输入框两段处理」。不传则保持 Radix 默认
   * （点层外即关、最高层 Esc 关）。 */
  onInteractOutside?: ContentProps['onInteractOutside'];
  onEscapeKeyDown?: ContentProps['onEscapeKeyDown'];
  /** combobox a11y 三件套透传到面板元素：调用方输入框用 aria-controls 指向 id。 */
  id?: string;
  role?: string;
  ariaLabel?: string;
  /** 追加到面板容器：面板视觉 token（圆角/阴影/最大高）从这里覆盖默认（cn 走 tailwind-merge，后者优先）。 */
  className?: string;
}

/**
 * 浮层 Popover（motion-spec §1-L2 / §4）：Radix Popover 提供 Portal 定位、碰撞规避、
 * 点外关闭（non-modal，不锁焦点/滚动、不做 aria-hide 兄弟节点），motion 负责出入——
 * 入场缩放 0.97→1 + 淡入 140ms，退场纯淡出 100ms（transitions.menu），与 Menu 同档。
 * prefers-reduced-motion 时只做纯 opacity 淡变（模式对齐 menu.tsx）。
 */
export function Popover({
  open,
  onOpenChange,
  anchor,
  children,
  side = 'bottom',
  sideOffset = 4,
  align = 'start',
  contentWidth = 'trigger',
  preventOpenAutoFocus = true,
  onInteractOutside,
  onEscapeKeyDown,
  id,
  role,
  ariaLabel,
  className,
}: PopoverProps) {
  const reduceMotion = useReducedMotion();

  const entrance = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, scale: 0.97 },
        animate: { opacity: 1, scale: 1 },
        // §1-L2：Popover/搜索下拉退场 = 100ms 纯淡出（去 scale），menu 档盖过组件级 fade 档
        exit: { opacity: 0, transition: transitions.menu },
      };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {anchor ? <PopoverPrimitive.Anchor asChild>{anchor}</PopoverPrimitive.Anchor> : null}
      <AnimatePresence>
        {open ? (
          <PopoverPrimitive.Portal forceMount>
            <PopoverPrimitive.Content
              asChild
              forceMount
              side={side}
              sideOffset={sideOffset}
              align={align}
              collisionPadding={8}
              id={id}
              role={role}
              aria-label={ariaLabel}
              onOpenAutoFocus={(event) => {
                if (preventOpenAutoFocus) event.preventDefault();
              }}
              onInteractOutside={onInteractOutside}
              onEscapeKeyDown={onEscapeKeyDown}
              className="z-[65]"
            >
              <motion.div
                {...entrance}
                transition={transitions.fade}
                style={
                  contentWidth === 'trigger'
                    ? undefined
                    : { width: typeof contentWidth === 'number' ? `${contentWidth}px` : contentWidth }
                }
                className={cn(
                  'max-h-[70vh] overflow-y-auto rounded-control border border-border bg-bg-surface py-1 shadow-pop atb-scroll outline-none',
                  contentWidth === 'trigger' && 'w-[var(--radix-popover-trigger-width)]',
                  className,
                )}
              >
                {children}
              </motion.div>
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        ) : null}
      </AnimatePresence>
    </PopoverPrimitive.Root>
  );
}
