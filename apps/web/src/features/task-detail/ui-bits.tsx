import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button, ErrorText, Skeleton } from '@/components/ui';

/**
 * 抽屉内的排版基元。原型 4.4–4.10 的每个标签都由「分区标题 + 行块」组成，
 * 与其在六份 Tab 里各写一遍 div，不如在这里钉死间距，保证六个 Tab 视觉同构。
 * 组件库里没有对应的（`Card` 是看板卡级别的容器，抽屉分区比它轻一档）。
 */

export interface SectionProps {
  title: ReactNode;
  /** 4.7「前置任务 (2/3 已完成)」这类括号里的统计。 */
  meta?: ReactNode;
  action?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function Section({ title, meta, action, className, bodyClassName, children }: SectionProps) {
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      <div className="flex min-h-6 items-center gap-2">
        <h3 className="text-card-title font-semibold text-text-primary">{title}</h3>
        {meta ? <span className="text-aux text-text-tertiary">{meta}</span> : null}
        <span className="flex-1" />
        {action}
      </div>
      <div className={cn('flex flex-col gap-2', bodyClassName)}>{children}</div>
    </section>
  );
}

export interface KeyValueRow {
  label: ReactNode;
  value: ReactNode;
  /** 值为空时的展示：默认 `—`，编辑态可给占位控件。 */
  muted?: boolean;
}

/** 原型 4.4 的两列表（左 140px 标签、右内容），用 dl 而不是 table：抽屉里没有排序/表头语义。 */
export function KeyValues({ rows, className }: { rows: readonly KeyValueRow[]; className?: string }) {
  return (
    <dl
      className={cn(
        'overflow-hidden rounded-card border border-border bg-bg-surface text-body',
        className,
      )}
    >
      {rows.map((row, index) => (
        <div
          key={index}
          className={cn(
            'flex items-start gap-3 px-3 py-2',
            index > 0 && 'border-t border-border',
          )}
        >
          <dt className="w-[120px] shrink-0 text-aux text-text-secondary">{row.label}</dt>
          <dd
            className={cn(
              'min-w-0 flex-1 break-words',
              row.muted ? 'text-text-tertiary' : 'text-text-primary',
            )}
            data-selectable
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 表单/请求的内联错误（409/422 这类需要留在原地解释的场景）。 */
export function InlineError({ text, className }: { text: ReactNode; className?: string }) {
  if (!text) return null;
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 rounded-control bg-status-failed-soft px-2 py-1.5 text-aux text-status-failed',
        className,
      )}
      role="alert"
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
}

export function LoadingBlock({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2 py-1">
      <Skeleton lines={lines} />
    </div>
  );
}

/** 后续页查询用到的那几项（结构上兼容 react-query 的结果对象，便于无 DOM 单测直接渲染）。 */
export interface OlderPageQueryState {
  isError: boolean;
  error?: unknown;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
}

/**
 * 「更早那页没拿到」的行（tier-2 的第二层，2026-09-29「列表报错被渲染成空状态」），
 * 三个分页面共用：评论 4.8、审计 13 章、执行日志 6.3。
 *
 * 原来每一页都只被 `query.data?.items ?? []` 取数：第二页 500 时那一页贡献 0 行、界面上
 * 一点痕迹都没有，「加载更早」还照旧在——再点一次是 `pages + 1`，翻到更远处去，
 * 失败的那一页永远补不回来。这里让失败页显形，并且重试只打那一页（`refetch`，不动 pages）。
 *
 * 第一页失败不归这里：那时主列表压根没拿到内容，调用方整块换错误面（tier-1）。
 */
export function OlderPageError({ label, query }: { label: string; query: OlderPageQueryState }) {
  if (!query.isError) return null;
  return (
    <InlineError
      text={
        <>
          <ErrorText text={`更早的${label}加载失败`} error={query.error} />
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 self-start"
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            重试这一页
          </Button>
        </>
      }
    />
  );
}

/** 评论 Tab 的日期分隔（原型 4.8「── 今天 ──」）。 */
export function DayDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-1" aria-hidden>
      <span className="h-px flex-1 bg-border" />
      <span className="text-aux text-text-tertiary">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** 4.5 的「↳ 审核结论：…」二级说明行。 */
export function SubLine({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1 pl-3 text-aux text-text-tertiary">
      <span aria-hidden>↳</span>
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/** 任务 ID / Run ID 等等宽短文本（1.2 的 `--text-code` + `--font-mono`）。 */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-mono text-code text-text-secondary', className)} data-selectable>
      {children}
    </span>
  );
}

/**
 * 原型 4.7 的状态图标：✅ 绿 / ⏳ 灰 / ❌ 红。
 * 颜色只从 1.1 的状态 token 取，`RUNNING` 与 `REVIEW` 这类中间态都归到「等待」的灰。
 */
export function StatusGlyph({ status, className }: { status: string; className?: string }) {
  if (status === 'DONE') {
    return <CheckCircle2 className={cn('size-4 shrink-0 text-status-done', className)} aria-hidden />;
  }
  if (status === 'FAILED') {
    return <XCircle className={cn('size-4 shrink-0 text-status-failed', className)} aria-hidden />;
  }
  return <Clock3 className={cn('size-4 shrink-0 text-text-tertiary', className)} aria-hidden />;
}
