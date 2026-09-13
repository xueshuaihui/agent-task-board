import { useMemo } from 'react';
import { CheckCircle2, ClipboardList, XCircle } from 'lucide-react';
import type { Review } from '@/api';
import { EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';
import { REVIEW_CONCLUSION_LABEL, labelOf, statusLabel } from '@/lib/labels';
import { formatDateTime } from '@/lib/time';
import { REVIEW_FEEDBACK_NOTE } from '../labels';
import { useTaskReviews } from '../queries';
import { InlineError, LoadingBlock, Mono, Section } from '../ui-bits';

/**
 * 原型 4.6 审核标签：`GET /tasks/{id}/reviews` 的全量历史（时间倒序）。
 *
 * 三字段（建议 / 原因 / 详情）在任何一条记录里都非空——4.3 把三者定为必填，
 * 通过与否都一样，所以界面**不给**「详情：无」这种占位；「退回目标 / 优先级调整」
 * 只在 `REJECT` 时渲染，通过记录不占位。
 *
 * 6.6 的 `review_feedback` 是 Agent 凭证组的接口（13 章：`GET /tasks/:id/review-feedback`
 * 带 `@AuthScope('agent')`，UI Token 拿不到），所以这里用同一批 reviews 复现 Agent 将读到的
 * 那五条字段，让「人写下去的东西 Agent 到底看到什么」在抽屉里可见。
 */

const CONCLUSION_TEXT: Record<string, string> = {
  ...REVIEW_CONCLUSION_LABEL,
  APPROVE: '已通过',
  REJECT: '已驳回',
};

export function ReviewsTab({ taskId }: { taskId: string }) {
  const reviews = useTaskReviews(taskId);
  const items = reviews.data?.items ?? [];
  const rejected = useMemo(() => items.filter((item) => item.conclusion === 'REJECT'), [items]);

  if (reviews.isPending) return <LoadingBlock lines={4} />;
  if (reviews.isError) return <InlineError text={reviews.error.message} />;

  return (
    <div className="flex flex-col gap-5">
      <Section title="审核记录" meta={items.length > 0 ? `共 ${items.length} 条` : undefined}>
        {items.length === 0 ? (
          <EmptyState
            icon={<ClipboardList className="size-6" />}
            title="还没有审核记录"
            description="任务进入待审核后，通过或驳回都会在这里留下记录（只增不改不删，6.5）。"
          />
        ) : (
          items.map((review) => <ReviewCard key={review.id} review={review} />)
        )}
      </Section>

      <Section
        title="Agent 侧的回传意见"
        meta={REVIEW_FEEDBACK_NOTE}
      >
        {rejected.length === 0 ? (
          <p className="text-aux text-text-tertiary">没有驳回记录，Agent 下次领取时读不到回传意见。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rejected.slice(0, 5).map((review) => (
              <li
                key={review.id}
                className="rounded-card border border-border bg-bg-muted px-3 py-2 text-aux text-text-secondary"
              >
                <Mono>{review.run_id ?? '—'}</Mono>
                <span className="ml-2 font-mono text-code">{review.conclusion}</span>
                <p className="mt-1 break-words">suggestion：{review.suggestion}</p>
                <p className="break-words">reason：{review.reason}</p>
                <p className="break-words">detail：{review.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function ReviewCard({ review }: { review: Review }) {
  const rejected = review.conclusion === 'REJECT';
  return (
    <article className="rounded-card border border-border bg-bg-surface shadow-card">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        {rejected ? (
          <XCircle className="size-4 shrink-0 text-status-failed" aria-hidden />
        ) : (
          <CheckCircle2 className="size-4 shrink-0 text-status-done" aria-hidden />
        )}
        <span
          className={cn(
            'text-card-title font-medium',
            rejected ? 'text-status-failed' : 'text-status-done',
          )}
        >
          {labelOf(CONCLUSION_TEXT, review.conclusion)}
        </span>
        <span className="flex-1" />
        <span className="shrink-0 text-aux text-text-tertiary">{formatDateTime(review.created_at)}</span>
        {review.run_id ? <Mono className="shrink-0">{review.run_id}</Mono> : null}
      </header>
      <div className="flex flex-col gap-1 px-3 py-2 text-body">
        <OpinionLine label="审核建议" value={review.suggestion} />
        <OpinionLine label="原因" value={review.reason} />
        <OpinionLine label="详情" value={review.detail} />
        {rejected ? (
          <p className="mt-1 text-aux text-text-secondary">
            退回目标：{review.return_to ? statusLabel(review.return_to) : '—'}
            {review.priority_adj !== null && review.priority_adj !== undefined
              ? ` · 优先级调整：P${review.priority_adj}`
              : ''}
          </p>
        ) : null}
      </div>
    </article>
  );
}

function OpinionLine({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex items-start gap-2">
      <span className="w-[52px] shrink-0 text-aux text-text-secondary">{label}</span>
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap text-text-primary" data-selectable>
        {value}
      </span>
    </p>
  );
}
