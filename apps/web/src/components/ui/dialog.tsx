import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useEscape, useLockBodyScroll } from '@/lib/dismiss';
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

/** 10.5 确认弹窗与 6.5 审核表单的共用壳：1.4 圆角 12px + `shadow-modal`，1.6 淡入 160ms。 */
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
  const panelRef = useRef<HTMLDivElement>(null);
  useEscape(open, () => {
    if (dismissible) onClose();
  });
  useLockBodyScroll(open);

  useEffect(() => {
    if (!open) return;
    // 打开时把焦点送进面板：Esc 与 Tab 环才归它管，而不是留在触发按钮上。
    const target = panelRef.current?.querySelector<HTMLElement>(
      'input,textarea,select,button:not([disabled])',
    );
    (target ?? panelRef.current)?.focus({ preventScroll: true });
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-[rgba(15,23,42,0.45)]"
        onClick={dismissible ? onClose : undefined}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
          'relative flex max-h-full w-full flex-col overflow-hidden rounded-modal bg-bg-surface shadow-modal outline-none',
          'animate-dialog-in',
          size === 'review' ? 'max-w-review-form' : 'max-w-dialog',
          className,
        )}
      >
        {title !== undefined || dismissible ? (
          <header className="flex h-11 shrink-0 items-center justify-between gap-4 border-b border-border px-5">
            <h2 className="truncate text-section-title text-text-primary">{title}</h2>
            {dismissible ? <IconButton label="关闭" size="iconSm" onClick={onClose} icon={<X className="size-4" />} /> : null}
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
    </div>,
    document.body,
  );
}
