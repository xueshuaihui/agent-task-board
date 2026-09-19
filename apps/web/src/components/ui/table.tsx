import type { HTMLAttributes, ReactNode, ThHTMLAttributes, TdHTMLAttributes } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ListSortField } from '@/api/types';

/**
 * 3.8 任务列表页是全应用**唯一**的表格实现（审核页与抽屉里的列表都用卡片/行块，不用这张表）。
 * 列宽由调用方按原型的表格逐列给（选择框 36 / ID 90 / 类型 88 / 优先级 64 / 状态 96 /
 * 标签 160 / Agent 104 / 时长 72 / 更新时间 104 / 操作 44）。
 *
 * 设计改版（DESIGN.md §4 任务列表）：表头吸顶（raised 底 + 底部 1px 分隔，
 * sticky 落在 th 上——WKWebView 不支持 thead 粘性定位）；行 hover primary-light 淡底
 * + 左侧 2px 主色指示条（inset box-shadow，不占布局）。颜色一律走 token。
 */
export function Table({ className, children, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="atb-scroll w-full overflow-x-auto">
      <table
        className={cn('w-full min-w-[960px] border-collapse text-body', className)}
        {...rest}
      >
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="text-aux text-text-secondary">{children}</thead>;
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function TR({ className, children, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        // 行分隔用边框而不是阴影：整行可点时 hover 才有一致的落点。
        // hover 左侧 2px 主色指示条走 inset box-shadow，不改变行高与列宽。
        'border-b border-border transition-[background-color,box-shadow] duration-120 ease-out',
        'hover:bg-primary-light hover:shadow-[inset_2px_0_0_0_var(--color-primary)]',
        className,
      )}
      {...rest}
    >
      {children}
    </tr>
  );
}

export interface THProps extends ThHTMLAttributes<HTMLTableCellElement> {
  /** 3.8：可排序列只有 id / priority / status / updated_at / created_at。 */
  sortField?: ListSortField;
  sort?: { field: ListSortField; order: 'asc' | 'desc' };
  onSort?: (field: ListSortField) => void;
}

export function TH({ className, sortField, sort, onSort, children, ...rest }: THProps) {
  const active = sortField !== undefined && sort?.field === sortField;
  const content = (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {children}
      {sortField && onSort ? (
        active ? (
          sort?.order === 'asc' ? (
            <ArrowUp className="size-3 text-primary" />
          ) : (
            <ArrowDown className="size-3 text-primary" />
          )
        ) : (
          <ArrowUpDown className="size-3 text-text-tertiary" />
        )
      ) : null}
    </span>
  );
  return (
    <th
      scope="col"
      className={cn(
        // 吸顶表头：raised 底盖住滚过的行；底边用 inset box-shadow，
        // 避免 border-collapse 下 WebKit 粘性单元格边框随滚动消失。
        'sticky top-0 z-10 h-11 bg-bg-raised px-3 text-left font-medium',
        'shadow-[inset_0_-1px_0_0_var(--color-border)]',
        className,
      )}
      aria-sort={active ? (sort?.order === 'asc' ? 'ascending' : 'descending') : undefined}
      {...rest}
    >
      {sortField && onSort ? (
        <button
          type="button"
          onClick={() => onSort(sortField)}
          className="inline-flex items-center rounded-control hover:text-text-primary"
        >
          {content}
        </button>
      ) : (
        content
      )}
    </th>
  );
}

export function TD({ className, children, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('px-3 py-2 align-middle text-text-primary', className)} {...rest}>
      {children}
    </td>
  );
}

/** ID 列：`--font-mono` 13px（原型 3.8 与 1.2 的任务 ID/代码档），叠 tabular-nums。 */
export function MonoCell({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn('font-mono text-code tabular-nums text-text-secondary', className)}
      data-selectable
    >
      {children}
    </span>
  );
}
