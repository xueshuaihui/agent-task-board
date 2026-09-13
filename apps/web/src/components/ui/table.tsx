import type { HTMLAttributes, ReactNode, ThHTMLAttributes, TdHTMLAttributes } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ListSortField } from '@/api/types';

/**
 * 3.8 任务列表页是全应用**唯一**的表格实现（审核页与抽屉里的列表都用卡片/行块，不用这张表）。
 * 列宽由调用方按原型的表格逐列给（选择框 36 / ID 90 / 类型 88 / 优先级 64 / 状态 96 /
 * 标签 160 / Agent 104 / 时长 72 / 更新时间 104 / 操作 44）。
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
  return (
    <thead className="bg-bg-muted text-aux text-text-secondary">
      <tr>{children}</tr>
    </thead>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function TR({ className, children, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        // 行分隔用边框而不是阴影：整行可点时 hover 才有一致的落点。
        'border-b border-border transition-colors duration-120 ease-out hover:bg-primary-light',
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
    <span className="inline-flex items-center gap-1">
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
      className={cn('h-11 px-3 text-left font-medium', className)}
      aria-sort={active ? (sort?.order === 'asc' ? 'ascending' : 'descending') : undefined}
      {...rest}
    >
      {sortField && onSort ? (
        <button
          type="button"
          onClick={() => onSort(sortField)}
          className="inline-flex items-center hover:text-text-primary"
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

/** ID 列：`--font-mono` 13px（原型 3.8 与 1.2 的任务 ID/代码档）。 */
export function MonoCell({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn('font-mono text-code text-text-secondary', className)} data-selectable>
      {children}
    </span>
  );
}
