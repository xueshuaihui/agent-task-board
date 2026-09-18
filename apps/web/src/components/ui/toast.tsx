import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { Toaster, toast } from 'sonner';
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

/** 卡片皮肤走 token：surface 底 + 状态色左描边；图标用 lucide 描边系（§2 Toast）。 */
function ToastCard({ item, onClose }: { item: Omit<ToastItem, 'id'>; onClose: () => void }) {
  return (
    <div
      className={cn(
        'flex w-[420px] items-start gap-2 rounded-card border border-border border-l-[3px] bg-bg-surface px-3 py-2 shadow-pop',
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
        onClick={onClose}
        className="shrink-0 text-text-tertiary hover:text-text-secondary"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const seq = useRef(0);

  const show = useCallback((item: Omit<ToastItem, 'id'>) => {
    seq.current += 1;
    const id = seq.current;
    // sonner 承担入退场动画、悬停暂停、自动消失；id 用我们的自增号，
    // dismiss(id) 才能对上号。custom 模式不带 sonner 默认皮，样式全走 token。
    toast.custom(
      (toastId) => <ToastCard item={item} onClose={() => toast.dismiss(toastId)} />,
      { id, duration: DURATION[item.variant] },
    );
    return id;
  }, []);

  const dismiss = useCallback((id: number) => {
    toast.dismiss(id);
  }, []);

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
      <Toaster position="top-center" offset={16} gap={8} visibleToasts={5} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error('ToastProvider 未挂载：useToast() 必须在 <ToastProvider> 内使用');
  return value;
}
