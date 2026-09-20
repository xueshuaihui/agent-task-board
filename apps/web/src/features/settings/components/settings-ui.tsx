import type { ReactNode } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * 设置页各 Tab（v0.0.4 W5 起 9 个）共用的版式件（DESIGN.md §4 设置行）。
 *
 * 视觉层（2026-09 改版）：分区卡片直接复用基座 `Card`/`CardHeader`
 * （标题行走 `text-section-title`）；Token/字段/模板/备份这类列表行的操作按钮
 * 由 `RowActions` 做 hover 浮现（`group-hover/row`，键盘聚焦同样浮现）。
 * `components/ui/**` 由基座 agent 持有，这里只组合它、不改它。
 *
 * 全部配色/字号走 `styles/globals.css` 的 @theme token，不出现裸色值。
 */

/* ------------------------------------------------------------ Tab 顶部 */

export interface TabHeaderProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** 标题右侧的只读汇总（原型 7.8 的「共 6.6 MB」、7.7 的「共 4821 条」）。 */
  meta?: ReactNode;
}

export function TabHeader({ title, description, action, meta }: TabHeaderProps) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-baseline gap-3">
        <h2 className="shrink-0 text-page-title text-text-primary">{title}</h2>
        {meta ? <span className="truncate text-aux text-text-tertiary">{meta}</span> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      {description ? (
        <p className="w-full text-aux text-text-secondary">{description}</p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ 分区卡片 */

export interface SettingSectionProps {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  /** 无外框：审计列表那种「只有一块标题 + 内容」的场合。 */
  bare?: boolean;
}

export function SettingSection({
  title,
  description,
  action,
  meta,
  children,
  className,
  bare,
}: SettingSectionProps) {
  const head =
    title !== undefined || action || meta || description ? (
      <CardHeader className="h-auto min-h-11 flex-wrap justify-between gap-x-2 gap-y-1 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          {title !== undefined ? (
            <h3 className="shrink-0 text-section-title text-text-primary">{title}</h3>
          ) : null}
          {meta ? <span className="truncate text-aux text-text-tertiary">{meta}</span> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        {description ? (
          <p className="w-full text-aux text-text-tertiary">{description}</p>
        ) : null}
      </CardHeader>
    ) : null;

  if (bare) {
    return (
      <section className={cn('flex flex-col gap-2', className)}>
        {head ? <div className="px-0">{head}</div> : null}
        {children}
      </section>
    );
  }

  return (
    <Card className={cn('overflow-hidden', className)}>
      {head}
      <CardBody className="px-4 py-1">{children}</CardBody>
    </Card>
  );
}

/* --------------------------------------------------------------- 设置行 */

export interface SettingRowProps {
  label: ReactNode;
  /** 「改了会立刻影响什么、不影响什么」——原型 7.2 末条：不写功能定义。 */
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  required?: boolean;
  /** 控件栏宽度：下拉/输入 240px，词表与列表这类要占满的给 `fluid`。 */
  width?: 'control' | 'fluid' | 'narrow';
  className?: string;
  children: ReactNode;
}

const CONTROL_WIDTH = {
  /** 32px 档控件的标准栏（原型 7.2 右侧留说明文字）。 */
  control: 'w-[240px]',
  narrow: 'w-[160px]',
  fluid: 'w-full',
} as const;

export function SettingRow({
  label,
  hint,
  error,
  htmlFor,
  required,
  width = 'control',
  className,
  children,
}: SettingRowProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start gap-x-4 gap-y-1 border-b border-border py-3 last:border-b-0',
        className,
      )}
    >
      <div className="w-40 shrink-0 pt-1.5">
        <label
          htmlFor={htmlFor}
          className="block text-body font-medium text-text-primary"
        >
          {label}
          {required ? <span className="ml-1 text-status-failed">*</span> : null}
        </label>
      </div>
      <div className={cn('shrink-0', CONTROL_WIDTH[width])}>
        {children}
        {error ? <p className="mt-1 text-aux text-status-failed">{error}</p> : null}
      </div>
      {hint && !error ? (
        <p className="min-w-[200px] flex-1 pt-1.5 text-aux text-text-tertiary">{hint}</p>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------- 只读展示件 */

export interface StaticValueProps {
  children: ReactNode;
  /** 路径与版本：等宽，一眼看清边界（原型 7.7 / 7.9 的路径行）。 */
  mono?: boolean;
  /** 值缺失（尚未从桌面壳拿到）时给一个不撒谎的占位。 */
  muted?: boolean;
  className?: string;
}

export function StaticValue({ children, mono, muted, className }: StaticValueProps) {
  return (
    <span
      className={cn(
        'inline-flex min-h-8 items-center break-all text-body',
        mono && 'font-mono text-code',
        muted ? 'text-text-tertiary' : 'text-text-secondary',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** 只读行左侧的语义说明（原型 7.7「20 MB（固定，随版本发布）」）。 */
export function ReadOnlyTag({ children }: { children: ReactNode }) {
  return (
    <span className="ml-2 rounded-tag bg-bg-muted px-1.5 py-px text-badge text-text-tertiary">
      {children}
    </span>
  );
}

/* --------------------------------------------------------------- 表格 */

export interface SettingsTableProps<T> {
  /** Tailwind 任意值网格列，如 `grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_88px_120px]`。 */
  cols: string;
  head: readonly ReactNode[];
  items: readonly T[];
  rowKey: (item: T) => string;
  cells: (item: T, index: number) => readonly ReactNode[];
  align?: 'center' | 'start';
  /** 已吊销 / 已停用这类「保留但不参与」的行：灰显但不隐藏（原型 7.3）。 */
  rowTone?: (item: T) => 'muted' | undefined;
  empty?: ReactNode;
  className?: string;
}

/**
 * 设置页的列表（Token / 字段 / 模板 / 备份 / 审计）。
 *
 * 不复用 `components/ui/table` 的 `Table`：那张表带着 `min-w-[960px]` 与排序表头，
 * 是给 3.8 任务列表页（全应用唯一表格实现）准备的；设置页内容区只有窗口宽减 200px，
 * 撑 960px 会每条列表都出横向滚动条。列对齐改用网格，窄列不再靠 `colSpan` 猜。
 */
export function SettingsTable<T>({
  cols,
  head,
  items,
  rowKey,
  cells,
  align = 'center',
  rowTone,
  empty,
  className,
}: SettingsTableProps<T>) {
  return (
    <div
      className={cn(
        'atb-scroll w-full overflow-x-auto rounded-card border border-border bg-bg-surface',
        className,
      )}
    >
      <div className="min-w-[620px]">
        <div
          className={cn(
            'grid h-9 items-center gap-x-3 border-b border-border bg-bg-muted px-4 text-aux text-text-secondary',
            cols,
          )}
        >
          {head.map((cell, index) => (
            <span key={`head-${index}`} className="min-w-0 truncate">
              {cell}
            </span>
          ))}
        </div>
        {items.length === 0 ? (
          <div className="px-4 py-6">{empty}</div>
        ) : (
          items.map((item, index) => (
            <div
              key={rowKey(item)}
              className={cn(
                'group/row grid gap-x-3 border-b border-border px-4 last:border-b-0 transition-colors duration-120 ease-out hover:bg-primary-light',
                cols,
                align === 'center' ? 'items-center py-2' : 'items-start py-3',
                rowTone?.(item) === 'muted' && 'bg-bg-muted text-text-tertiary hover:bg-bg-muted',
              )}
            >
              {cells(item, index).map((cell, cellIndex) => (
                <span key={`cell-${cellIndex}`} className="min-w-0 text-body">
                  {cell}
                </span>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 杂项 */

/** 一组行内小按钮（编辑 / 停用 / 删除 / 恢复）：行 hover 或键盘聚焦时浮现（DESIGN §4 设置行）。 */
export function RowActions({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 opacity-0 translate-x-1 transition-[opacity,transform] duration-140 ease-out group-hover/row:opacity-100 group-hover/row:translate-x-0 focus-within:opacity-100 focus-within:translate-x-0">
      {children}
    </span>
  );
}

/** 表单底部的服务端错误条（422 的 fieldErrors 汇总在此，文案来自 `errorMessage`）。 */
export function FormError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="rounded-control bg-status-failed-soft px-3 py-2 text-aux text-status-failed">
      {children}
    </p>
  );
}

/** Tab 内两级分隔（原型 7.6 / 7.7 的 `─────`）。 */
export function SectionDivider({ className }: { className?: string }) {
  return <hr className={cn('my-4 border-0 border-t border-border', className)} />;
}
