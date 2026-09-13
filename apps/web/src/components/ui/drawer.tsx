import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useEscape, useLockBodyScroll } from '@/lib/dismiss';
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
 * 4.1 任务详情抽屉的容器：1.5 宽 640px、1.4 圆角「12px 左侧」+ `shadow-drawer`、
 * 1.6 滑入 240ms `ease-settle`；11.2 按窗口内容区宽度分 480/560/640 三档。
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
  useEscape(open, onClose);
  useLockBodyScroll(open);
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-[rgba(15,23,42,0.32)]" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative flex h-full w-[480px] flex-col bg-bg-surface',
          'win-lg:w-drawer-md win-xl:w-drawer',
          'animate-drawer-in rounded-l-drawer shadow-drawer',
          className,
        )}
      >
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
          <div className="min-w-0 flex-1 truncate text-section-title text-text-primary">{title}</div>
          <IconButton label="关闭抽屉" onClick={onClose} icon={<X className="size-4" />} />
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
      </aside>
    </div>,
    document.body,
  );
}
