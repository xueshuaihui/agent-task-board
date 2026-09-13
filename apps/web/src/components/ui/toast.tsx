import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: number;
  variant: ToastVariant;
  text: string;
  /** 错误里的第二行（服务端 message 之外的上下文，如校验明细条数）。 */
  detail?: string;
}

export interface ToastApi {
  show: (item: Omit<ToastItem, 'id'>) => number;
  success: (text: string, detail?: string) => number;
  error: (text: string, detail?: string) => number;
  warning: (text: string, detail?: string) => number;
  info: (text: string, detail?: string) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** 10.4：顶部居中、按类型描边；错误停留久一点（4.5 的文案要读得完）。 */
const DURATION: Record<ToastVariant, number> = {
  success: 2_400,
  info: 2_400,
  warning: 4_000,
  error: 6_000,
};

const STYLE: Record<ToastVariant, { border: string; icon: ReactNode }> = {
  success: { border: 'border-l-status-done', icon: <CheckCircle2 className="size-4 text-status-done" /> },
  error: { border: 'border-l-status-failed', icon: <XCircle className="size-4 text-status-failed" /> },
  warning: { border: 'border-l-status-running', icon: <AlertTriangle className="size-4 text-status-running" /> },
  info: { border: 'border-l-primary', icon: <Info className="size-4 text-primary" /> },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const show = useCallback(
    (item: Omit<ToastItem, 'id'>) => {
      seq.current += 1;
      const id = seq.current;
      setItems((current) => [...current.slice(-4), { ...item, id }]);
      setTimeout(() => dismiss(id), DURATION[item.variant]);
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      success: (text, detail) => show({ variant: 'success', text, detail }),
      error: (text, detail) => show({ variant: 'error', text, detail }),
      warning: (text, detail) => show({ variant: 'warning', text, detail }),
      info: (text, detail) => show({ variant: 'info', text, detail }),
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div
          aria-live="polite"
          className="pointer-events-none fixed left-1/2 top-4 z-[60] flex w-[420px] -translate-x-1/2 flex-col items-center gap-2"
        >
          {items.map((item) => (
            <div
              key={item.id}
              className={cn(
                'pointer-events-auto flex w-full items-start gap-2 rounded-card border border-border border-l-[3px] bg-bg-surface px-3 py-2 shadow-card-hover animate-toast-in',
                STYLE[item.variant].border,
              )}
            >
              <span className="mt-[2px] shrink-0">{STYLE[item.variant].icon}</span>
              <span className="min-w-0 flex-1 text-body text-text-primary">
                {item.text}
                {item.detail ? (
                  <span className="mt-1 block text-aux text-text-secondary" data-selectable>
                    {item.detail}
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => dismiss(item.id)}
                className="shrink-0 text-text-tertiary hover:text-text-secondary"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error('ToastProvider 未挂载：useToast() 必须在 <ToastProvider> 内使用');
  return value;
}
