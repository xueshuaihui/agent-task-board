import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useClickOutside, useEscape } from '@/lib/dismiss';

export interface MenuItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  /** 4.5：删除/强制停止这类不可逆动作描红。 */
  danger?: boolean;
  disabled?: boolean;
  /** 分组说明（同一份按状态生成的动作集里，「流转」与「元数据」要分开）。 */
  hint?: string;
  onSelect?: () => void;
}

export interface MenuGroup {
  label?: string;
  items: readonly MenuItem[];
}

export interface MenuProps {
  /** 触发器由调用方给（Button / IconButton），组件负责包一层相对定位。 */
  trigger: (props: { open: boolean; toggle: () => void; id: string }) => ReactNode;
  groups: readonly (MenuItem | MenuGroup)[];
  /** 单选语义（3.4 视图预设、8.5 导入策略）：给 selectedId 就画对勾。 */
  selectedId?: string;
  align?: 'start' | 'end';
  /** 菜单宽度：2.3 托盘菜单 220px 是同类控件的参照。 */
  width?: number;
  className?: string;
}

function isGroup(entry: MenuItem | MenuGroup): entry is MenuGroup {
  return 'items' in entry;
}

/**
 * 下拉菜单。用 portal + fixed 定位：看板列与表格单元格都带 overflow，
 * 就地渲染的菜单会被裁一半（3.8 的 `⋯` 在最后一列时必踩）。
 */
export function Menu({
  trigger,
  groups,
  selectedId,
  align = 'start',
  width = 220,
  className,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useClickOutside(open, [triggerRef, panelRef], () => setOpen(false));
  useEscape(open, () => setOpen(false));

  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = align === 'end' ? rect.right - width : rect.left;
    setCoords({
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      top: rect.bottom + 4,
    });
  }, [open, align, width]);

  const entries: MenuGroup[] = groups.map((entry) => (isGroup(entry) ? entry : { items: [entry] }));

  return (
    <span ref={triggerRef} className="relative inline-flex">
      {trigger({ open, toggle: () => setOpen((value) => !value), id })}
      {open && coords
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              style={{ left: coords.left, top: coords.top, width }}
              className={cn(
                'fixed z-[65] max-h-[70vh] overflow-y-auto rounded-card border border-border bg-bg-surface py-1 shadow-modal animate-dialog-in atb-scroll',
                className,
              )}
            >
              {entries.map((group, groupIndex) => (
                <div
                  key={group.label ?? groupIndex}
                  className={cn(groupIndex > 0 && 'mt-1 border-t border-border pt-1')}
                >
                  {group.label ? (
                    <p className="px-3 py-1 text-aux text-text-tertiary">{group.label}</p>
                  ) : null}
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      disabled={item.disabled}
                      onClick={() => {
                        setOpen(false);
                        item.onSelect?.();
                      }}
                      className={cn(
                        'flex h-8 w-full items-center gap-2 px-3 text-left text-body transition-colors duration-120 ease-out',
                        'hover:bg-bg-muted',
                        item.danger && 'text-status-failed hover:bg-status-failed-soft',
                        item.disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
                      )}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center text-text-secondary">
                        {selectedId === item.id ? (
                          <Check className="size-3.5 text-primary" />
                        ) : (
                          item.icon
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.hint ? (
                        <span className="shrink-0 text-aux text-text-tertiary">{item.hint}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

/** 触发器常用的「文字 + ▾」组合（「新建任务 ▾」「移动到 ▾」）。 */
export function MenuCaret({ open }: { open: boolean }) {
  return <ChevronDown className={cn('size-3.5 transition-transform duration-120', open && 'rotate-180')} />;
}
