import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Search } from 'lucide-react';
import { api } from '@/api';
import type { TaskListItem } from '@/api/types';
import { StatusDot } from '@/components/ui';
import { priorityStyle, statusStyle } from '@/lib/status-style';
import { cn } from '@/lib/cn';
import { useShellStore } from './store/shell';

/**
 * 2.md 2.4 全局搜索：顶栏中部搜索框，Cmd/Ctrl+K 聚焦、Esc 收起。
 * 下拉可用 ↑↓ 在结果间移动、Enter 选中（纯键盘也能走完「⌘K → 输入 → 打开任务」）。
 *
 * 范围本期只做任务：输入 ≥1 字符防抖 300ms 后调 `GET /api/v1/tasks?keyword=…`
 * （服务端 `listQuerySchema.keyword`，上限 120，这里按同口径截断），下拉最多展示
 * 8 条（编号 + 标题 + 状态色点 + 优先级），点击复用壳层的 `openTask` 打开详情抽屉
 * （overlay-slot 只挂一份 TaskDetailDrawer，见 app/overlay-slot.tsx）。
 *
 * 技能 / 分组 / 命令分组是 2.4 原型的完整形态：技能与分组各有自己的检索端点规划、
 * 命令是调色板能力，本期服务端与调色板不落地，先不渲染空分组。
 */
const DEBOUNCE_MS = 300;
const KEYWORD_MAX = 120;
const RESULT_LIMIT = 8;

function priorityText(priority: number): string {
  return priority >= 0 && priority <= 3 ? `P${priority}` : '优先级';
}

/** `aria-activedescendant` 指向的行 id；任务 id 里有 `#`，要转成合法的 DOM id。 */
function optionId(taskId: string): string {
  return `global-search-option-${taskId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

export function GlobalSearch() {
  const [value, setValue] = useState('');
  /** 防抖后的真值：只有它驱动请求。 */
  const [keyword, setKeyword] = useState('');
  const [open, setOpen] = useState(false);
  /** 键盘高亮项：结果变化后回到第一条，避免停在已消失的行上。 */
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const openTask = useShellStore((state) => state.openTask);

  const debounced = useMemo(() => keyword.trim().slice(0, KEYWORD_MAX), [keyword]);

  // 2.4：Cmd/Ctrl+K 全局聚焦。注册在 window 上，抽屉/弹窗打开时同样生效。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 点击框外收起下拉（Mousedown 而非 Click：赶在输入框 blur 清场之前判断）。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    const timer = window.setTimeout(() => setKeyword(value), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);

  const query = useQuery({
    queryKey: ['global-search', debounced],
    queryFn: () => api.tasks.list({ keyword: debounced, page_size: RESULT_LIMIT }),
    enabled: debounced.length >= 1,
    placeholderData: (previous) => previous,
  });

  const items: TaskListItem[] = useMemo(() => query.data?.items ?? [], [query.data]);
  /** 只有关键词就绪才叫「有结果可显」；输入框空着时不该出现空态。 */
  const showDropdown = open && debounced.length >= 1;
  useEffect(() => {
    setActive(0);
  }, [debounced]);
  const onSelect = (id: string) => {
    openTask(id);
    setOpen(false);
    setValue('');
    setKeyword('');
    inputRef.current?.blur();
  };

  return (
    <div ref={rootRef} className="relative w-full max-w-[480px]">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-tertiary"
        aria-hidden
      />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={showDropdown}
        aria-controls="global-search-listbox"
        aria-activedescendant={
          showDropdown && items.length > 0 ? optionId(items[Math.min(active, items.length - 1)].id) : undefined
        }
        aria-label="全局搜索任务"
        placeholder="搜索任务…"
        className={cn(
          'h-9 w-full rounded-control border border-border bg-bg-surface pl-8 pr-14 text-body text-text-primary',
          'placeholder:text-text-tertiary focus:border-primary focus:outline-none',
        )}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            // 先收下拉；输入框还留着内容时再按一次 Esc 才交还焦点。
            if (showDropdown) {
              setOpen(false);
            } else {
              event.currentTarget.blur();
            }
            return;
          }
          if (!showDropdown || items.length === 0) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            setActive((prev) => (prev + delta + items.length) % items.length);
            return;
          }
          if (event.key === 'Enter') {
            const row = items[Math.min(active, items.length - 1)];
            if (row) {
              event.preventDefault();
              onSelect(row.id);
            }
          }
        }}
      />
      {/* 2.4：右侧快捷键提示角标。 */}
      <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-badge border border-border bg-bg-muted px-1.5 py-0.5 font-mono text-badge text-text-tertiary">
        {navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl+K'}
      </kbd>

      {showDropdown ? (
        <div
          role="listbox"
          id="global-search-listbox"
          aria-label="搜索结果"
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 max-h-[360px] overflow-y-auto rounded-card border border-border bg-bg-surface py-1 shadow-card"
        >
          {query.isPending ? (
            <p className="flex items-center gap-2 px-3 py-3 text-aux text-text-secondary">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              搜索中…
            </p>
          ) : query.isError ? (
            <p className="px-3 py-3 text-aux text-status-failed">搜索失败，请稍后重试。</p>
          ) : items.length === 0 ? (
            <p className="px-3 py-3 text-aux text-text-secondary">没有匹配「{debounced}」的任务。</p>
          ) : (
            items.map((row, index) => {
              const status = statusStyle(row.status);
              const priority = priorityStyle(row.priority);
              const isActive = index === Math.min(active, items.length - 1);
              return (
                <button
                  key={row.id}
                  id={optionId(row.id)}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => onSelect(row.id)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-120 ease-out hover:bg-primary-light',
                    isActive && 'bg-primary-light',
                  )}
                >
                  <StatusDot className={status.dot} />
                  <span className="font-mono text-aux text-text-tertiary">{row.id}</span>
                  <span className="min-w-0 flex-1 truncate text-body text-text-primary">
                    {row.title || '（无标题）'}
                  </span>
                  <span className={cn('shrink-0 text-aux font-mono', priority.text)}>
                    {priorityText(row.priority)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
