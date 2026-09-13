import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  /** 3.8「更新时间」列：hover 看绝对时间。默认在上方，靠窗口边缘时翻转。 */
  side?: 'top' | 'bottom';
  className?: string;
}

/** 无依赖的轻实现：hover/focus 延迟 300ms 显示，用 fixed 定位避免被列的 overflow 裁掉。 */
export function Tooltip({ content, children, side = 'top', className }: TooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      setCoords({
        x: rect.left + rect.width / 2,
        y: side === 'top' ? rect.top : rect.bottom,
      });
    }, 300);
  };

  const close = () => {
    if (timer.current) clearTimeout(timer.current);
    setCoords(null);
  };

  return (
    <>
      <span
        ref={anchorRef}
        className="inline-flex min-w-0"
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
      >
        {children}
      </span>
      {coords
        ? createPortal(
            <span
              role="tooltip"
              className={cn(
                'pointer-events-none fixed z-[70] max-w-[280px] truncate rounded-control bg-text-primary px-2 py-1 text-aux text-text-inverse shadow-card-hover',
                side === 'top' ? '-translate-y-full' : 'translate-y-0',
                className,
              )}
              style={{ left: coords.x, top: coords.y, transform: `translate(-50%, ${side === 'top' ? '-4px' : '4px'})` }}
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
