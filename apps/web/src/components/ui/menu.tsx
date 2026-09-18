import { forwardRef, useId, useState, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { transitions } from '@/lib/motion';

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
 * Radix DropdownMenu 的开关由 Trigger 点击处理；render-prop 里的 toggle 保留在
 * API 里但做成幂等空操作——业务侧 `onClick={toggle}` 不会与 Radix 的开关叠加成
 * 开→关的抖动（DESIGN.md §2：render-prop 触发器 API 不变）。
 */
const noopToggle = (): void => {};

/**
 * 下拉菜单（DESIGN.md §2）：Radix DropdownMenu 提供焦点圈、方向键、Esc、
 * overflow 裁剪规避（Portal + 定位），motion 负责出入——缩放 0.97→1 + 淡入 140ms。
 */
export const Menu = forwardRef<HTMLSpanElement, MenuProps>(function Menu(
  { trigger, groups, selectedId, align = 'start', width = 220, className },
  ref,
) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const id = useId();

  const entries: MenuGroup[] = groups.map((entry) => (isGroup(entry) ? entry : { items: [entry] }));

  const entrance = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, scale: 0.97 },
        animate: { opacity: 1, scale: 1 },
        exit: { opacity: 0, scale: 0.97 },
      };

  return (
    <span ref={ref} className="relative inline-flex">
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>{trigger({ open, toggle: noopToggle, id })}</DropdownMenu.Trigger>
        <AnimatePresence>
          {open ? (
            <DropdownMenu.Portal forceMount>
              <DropdownMenu.Content
                asChild
                align={align}
                sideOffset={4}
                collisionPadding={8}
                className="z-[65]"
              >
                <motion.div
                  {...entrance}
                  transition={transitions.fade}
                  style={{ width }}
                  className={cn(
                    'max-h-[70vh] overflow-y-auto rounded-control border border-border bg-bg-surface py-1 shadow-pop atb-scroll outline-none',
                    className,
                  )}
                >
                  {entries.map((group, groupIndex) => (
                    <DropdownMenu.Group
                      key={group.label ?? groupIndex}
                      className={cn(groupIndex > 0 && 'mt-1 border-t border-border pt-1')}
                    >
                      {group.label ? (
                        <DropdownMenu.Label className="px-3 py-1 text-aux text-text-tertiary">
                          {group.label}
                        </DropdownMenu.Label>
                      ) : null}
                      {group.items.map((item) => (
                        <DropdownMenu.Item
                          key={item.id}
                          disabled={item.disabled}
                          onSelect={() => item.onSelect?.()}
                          className={cn(
                            'flex h-8 w-full cursor-default select-none items-center gap-2 px-3 text-left text-body outline-none transition-colors duration-120 ease-out',
                            'data-[highlighted]:bg-bg-muted',
                            item.danger && 'text-status-failed data-[highlighted]:bg-status-failed-soft',
                            item.disabled && 'cursor-not-allowed opacity-40 data-[highlighted]:bg-transparent',
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
                        </DropdownMenu.Item>
                      ))}
                    </DropdownMenu.Group>
                  ))}
                </motion.div>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          ) : null}
        </AnimatePresence>
      </DropdownMenu.Root>
    </span>
  );
});

/** 触发器常用的「文字 + ▾」组合（「新建任务 ▾」「移动到 ▾」）。 */
export function MenuCaret({ open }: { open: boolean }) {
  return <ChevronDown className={cn('size-3.5 transition-transform duration-120', open && 'rotate-180')} />;
}
