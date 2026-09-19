import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Select } from './select';

export interface PaginationProps {
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  /** 3.8：`page_size` 可选 50/100/200，选中值存本地偏好、不进 settings。 */
  onPageSizeChange?: (size: number) => void;
  pageSizes?: readonly number[];
  className?: string;
}

/** 底部一条：`共 128 条 · 第 1/3 页 每页 [50▾] ‹ 1 2 3 ›`（原型 3.8）。 */
export function Pagination({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizes = [50, 100, 200],
  className,
}: PaginationProps) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const current = Math.min(Math.max(1, page), pages);
  return (
    <div
      className={cn(
        'flex h-11 items-center justify-end gap-3 border-t border-border text-aux tabular-nums text-text-secondary',
        className,
      )}
    >
      <span className="shrink-0 whitespace-nowrap">
        共 {total} 条 · 第 {current}/{pages} 页
      </span>
      {onPageSizeChange ? (
        // shrink-0 + nowrap：flex 行太挤时「每页」会被压成竖排逐字换行（label 宽度不足）。
        <label className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
          每页
          <Select
            className="h-7 w-[72px] px-2 text-aux"
            value={String(pageSize)}
            options={pageSizes.map((size) => ({ value: String(size), label: String(size) }))}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          />
        </label>
      ) : null}
      <div className="flex items-center gap-1">
        <PageArrow
          label="上一页"
          disabled={current <= 1}
          onClick={() => onPageChange(current - 1)}
        >
          <ChevronLeft className="size-4" />
        </PageArrow>
        {pageWindow(current, pages).map((item, index) =>
          item === 'gap' ? (
            <span key={`gap-${index}`} className="px-1 text-text-tertiary">
              …
            </span>
          ) : (
            <button
              key={item}
              type="button"
              aria-current={item === current ? 'page' : undefined}
              onClick={() => onPageChange(item)}
              className={cn(
                'inline-flex size-7 items-center justify-center rounded-control text-badge tabular-nums transition-colors duration-120 ease-out',
                item === current
                  ? 'bg-primary-light font-medium text-primary'
                  : 'text-text-secondary hover:bg-bg-muted hover:text-text-primary',
              )}
            >
              {item}
            </button>
          ),
        )}
        <PageArrow
          label="下一页"
          disabled={current >= pages}
          onClick={() => onPageChange(current + 1)}
        >
          <ChevronRight className="size-4" />
        </PageArrow>
      </div>
    </div>
  );
}

function PageArrow({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-7 items-center justify-center rounded-control text-text-secondary transition-colors duration-120 ease-out hover:bg-bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-secondary"
    >
      {children}
    </button>
  );
}

/** 页码窗口：首尾恒显，中间最多 3 个，超出用省略号（原型 3.8 的 `‹ 1 2 3 ›`）。 */
function pageWindow(current: number, pages: number): (number | 'gap')[] {
  if (pages <= 5) return Array.from({ length: pages }, (_, index) => index + 1);
  const items: (number | 'gap')[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(pages - 1, current + 1);
  if (start > 2) items.push('gap');
  for (let page = start; page <= end; page += 1) items.push(page);
  if (end < pages - 1) items.push('gap');
  items.push(pages);
  return items;
}
