import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Inbox, PlayCircle } from 'lucide-react';
import type { RunStatus, TaskDetail, TaskRun } from '@/api';
import { EmptyState, Progress, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  REVIEW_CONCLUSION_LABEL,
  RUN_STATUS_LABEL,
  TRIGGER_TYPE_LABEL,
  labelOf,
} from '@/lib/labels';
import { formatBytes, formatDateTime, formatDuration } from '@/lib/time';
import { useWSEvent } from '@/ws';
import { ArtifactList } from '../artifacts/artifact-list';
import { ArtifactPreviewDialog } from '../artifacts/preview-dialog';
import type { PreviewTarget } from '../types';
import { LOG_PAGE_SIZE, useRunLogPages, useTaskRuns } from '../queries';
import { InlineError, LoadingBlock, Mono, Section, SubLine } from '../ui-bits';

/**
 * 原型 4.5 执行标签：当前 Run + 历史 Run，产物按 Run 归组、日志按 Run 展开。
 *
 * 为什么产物不放概览：`artifacts.run_id NOT NULL`（20.6），单开一个跨 Run 平铺的产物区
 * 会丢掉「这是哪一次跑出来的」——那恰恰是驳回后最需要看的（原型 4.3 说明段）。
 *
 * `SUCCESS` 与「已驳回」分两行渲染：前者是 `task_runs.status`，后者是 `reviews.conclusion`，
 * 合成一个「❌ 已驳回」会让人去 `task_runs` 里找一个不存在的枚举值（原型 4.5）。
 */

const RUN_STATUS_CLASS: Record<RunStatus, string> = {
  RUNNING: 'text-status-running',
  SUCCESS: 'text-status-done',
  FAILED: 'text-status-failed',
  ABANDONED: 'text-status-blocked',
};

export interface RunsTabProps {
  taskId: string;
  detail: TaskDetail;
  maxMb: number;
}

export function RunsTab({ taskId, detail, maxMb }: RunsTabProps) {
  const runs = useTaskRuns(taskId);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  /** 4.5 的「有新输出」提示：`run.log` 事件只做渲染态，失效重取由 `src/ws/invalidate.ts` 负责。 */
  const [pendingNewLines, setPendingNewLines] = useState<Record<string, boolean>>({});

  useWSEvent(['run.log'], (frame) => {
    if (frame.data.task_id !== taskId) return;
    setPendingNewLines((prev) => ({ ...prev, [frame.data.run_id]: true }));
  });

  const items = runs.data?.items ?? [];
  const current = useMemo(
    () => items.find((run) => run.id === detail.current_run_id) ?? items[0],
    [items, detail.current_run_id],
  );
  const history = useMemo(() => items.filter((run) => run.id !== current?.id), [items, current]);

  if (runs.isPending) return <LoadingBlock lines={4} />;
  if (runs.isError) return <InlineError text={runs.error.message} />;
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Inbox className="size-6" />}
        title="还没有执行记录"
        description="任务被 Agent 认领后，这里会出现 Run、产物与日志。"
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Section title="当前 Run">
        <RunCard
          taskId={taskId}
          run={current}
          expanded={expanded[current.id] !== false}
          onToggle={() => setExpanded((prev) => ({ ...prev, [current.id]: !(prev[current.id] ?? true) }))}
          maxMb={maxMb}
          onPreview={setPreview}
          pendingNewLines={Boolean(pendingNewLines[current.id])}
          onClearNewLines={() => setPendingNewLines((prev) => ({ ...prev, [current.id]: false }))}
        />
      </Section>

      {history.length > 0 ? (
        <Section title="历史 Run" meta={`(${history.length})`}>
          <ul className="flex flex-col gap-2">
            {history.map((run) => (
              <li key={run.id}>
                <RunCard
                  taskId={taskId}
                  run={run}
                  compact
                  expanded={Boolean(expanded[run.id])}
                  onToggle={() => setExpanded((prev) => ({ ...prev, [run.id]: !prev[run.id] }))}
                  maxMb={maxMb}
                  onPreview={setPreview}
                  pendingNewLines={Boolean(pendingNewLines[run.id])}
                  onClearNewLines={() => setPendingNewLines((prev) => ({ ...prev, [run.id]: false }))}
                />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <ArtifactPreviewDialog target={preview} maxMb={maxMb} onClose={() => setPreview(null)} />
    </div>
  );
}

interface RunCardProps {
  taskId: string;
  run: TaskRun;
  maxMb: number;
  expanded: boolean;
  compact?: boolean;
  onToggle: () => void;
  onPreview: (target: PreviewTarget) => void;
  pendingNewLines: boolean;
  onClearNewLines: () => void;
}

function RunCard({
  taskId,
  run,
  maxMb,
  expanded,
  compact,
  onToggle,
  onPreview,
  pendingNewLines,
  onClearNewLines,
}: RunCardProps) {
  return (
    <article className="rounded-card border border-border bg-bg-surface shadow-card">
      <header className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {expanded ? (
            <ChevronDown className="size-4 shrink-0 text-text-tertiary" aria-hidden />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-text-tertiary" aria-hidden />
          )}
          <Mono className="shrink-0">{run.id}</Mono>
          <span className="min-w-0 truncate text-card-title text-text-primary">
            {run.agent_name ?? '未署名 Agent'}
          </span>
          <span className="shrink-0 text-aux text-text-tertiary">
            {clockOf(run.started_at)}
            {run.finished_at ? ` – ${clockOf(run.finished_at)}` : ' – …'}
          </span>
          <span className="shrink-0 text-aux text-text-tertiary">{formatDuration(run.duration_ms)}</span>
        </button>
        <span
          className={cn(
            'shrink-0 text-aux font-medium',
            RUN_STATUS_CLASS[run.status as RunStatus] ?? 'text-text-secondary',
          )}
        >
          {labelOf(RUN_STATUS_LABEL, run.status)}
        </span>
      </header>

      {run.progress !== null && run.status === 'RUNNING' ? (
        <div className="px-3 pb-2">
          <Progress value={run.progress} />
          {run.progress_msg ? (
            <p className="mt-1 text-aux text-text-secondary">{run.progress_msg}</p>
          ) : null}
        </div>
      ) : null}

      {expanded ? (
        <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
          <p className="text-aux text-text-tertiary">
            触发方式：{labelOf(TRIGGER_TYPE_LABEL, run.trigger_type)} · 日志 {run.log_count} 条
            {run.artifacts.length > 0 ? ` · 产物 ${run.artifacts.length} 个` : ''}
          </p>

          <div>
            <p className="mb-1 text-card-title text-text-primary">摘要</p>
            {run.summary ? (
              <p className="whitespace-pre-wrap break-words text-body text-text-primary" data-selectable>
                {run.summary}
              </p>
            ) : (
              <p className="text-aux text-text-tertiary">
                {run.status === 'RUNNING' ? '执行中，尚未回写摘要。' : '无回写摘要。'}
              </p>
            )}
            {run.error ? <SubLine>失败原因：{run.error}</SubLine> : null}
            {run.review ? (
              <SubLine>
                审核结论：{labelOf(REVIEW_CONCLUSION_LABEL, run.review.conclusion)}（
                {formatDateTime(run.review.created_at)}）
              </SubLine>
            ) : null}
          </div>

          <div>
            <p className="mb-1 text-card-title text-text-primary">产物</p>
            {run.artifacts.length === 0 ? (
              <p className="text-aux text-text-tertiary">本次执行没有产物。</p>
            ) : (
              <ArtifactList artifacts={run.artifacts} maxMb={maxMb} onPreview={onPreview} />
            )}
          </div>

          <LogBlock
            taskId={taskId}
            run={run}
            compact={compact}
            pendingNewLines={pendingNewLines}
            onClearNewLines={onClearNewLines}
          />
        </div>
      ) : (
        <div className="border-t border-border px-3 py-2">
          {run.review ? (
            <SubLine>
              审核结论：{labelOf(REVIEW_CONCLUSION_LABEL, run.review.conclusion)}（
              {formatDateTime(run.review.created_at)}）
            </SubLine>
          ) : null}
          {run.error ? <SubLine>{`error：${run.error}`}</SubLine> : null}
          {run.artifacts.length > 0 ? (
            <SubLine>
              {run.artifacts.length} 个产物
              {run.artifacts[0] ? `（${run.artifacts[0].name} ${formatBytes(run.artifacts[0].size_bytes)}）` : ''}
            </SubLine>
          ) : null}
        </div>
      )}
    </article>
  );
}

interface LogBlockProps {
  taskId: string;
  run: TaskRun;
  compact?: boolean;
  pendingNewLines: boolean;
  onClearNewLines: () => void;
}

/**
 * 日志块：`GET /runs/{id}/logs?page=&page_size=200`（13 章）。
 * 「加载更早」= page 递增，与文档口径一致；已加载页按 page 顺序拼接后正序渲染。
 */
function LogBlock({ taskId, run, pendingNewLines, onClearNewLines }: LogBlockProps) {
  const [pages, setPages] = useState(1);
  const queries = useRunLogPages(taskId, run.id, pages);

  const lines = useMemo(
    () => queries.flatMap((query) => query.data?.items ?? []),
    [queries],
  );
  const total = queries[queries.length - 1]?.data?.total ?? run.log_count;
  const loading = queries.some((query) => query.isPending);

  // 内容已经追上服务端的条数，就认为「新输出」已被读到（事件只是提示，不当真相用）。
  useEffect(() => {
    if (pendingNewLines && lines.length >= run.log_count) onClearNewLines();
  }, [pendingNewLines, lines.length, run.log_count, onClearNewLines]);

  const totalPages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <p className="text-card-title text-text-primary">日志</p>
        <span className="text-aux text-text-tertiary">
          {lines.length} / {total} 条
        </span>
        <span className="flex-1" />
        {pendingNewLines ? (
          <button
            type="button"
            onClick={() => {
              setPages(totalPages);
              onClearNewLines();
            }}
            className="inline-flex items-center gap-1 rounded-badge bg-primary-light px-2 py-px text-badge text-primary hover:bg-primary"
          >
            <PlayCircle className="size-3" aria-hidden />
            有新输出
          </button>
        ) : null}
      </div>

      {loading && lines.length === 0 ? (
        <Skeleton className="h-24 w-full rounded-card" />
      ) : lines.length === 0 ? (
        <p className="text-aux text-text-tertiary">
          {run.status === 'RUNNING' ? 'Agent 还没有上报日志。' : '本次执行没有日志。'}
        </p>
      ) : (
        <div
          className="atb-scroll max-h-64 overflow-auto rounded-card border border-border bg-bg-muted px-2 py-1"
          data-selectable
        >
          {lines.map((line) => (
            <p key={line.id} className="flex items-start gap-2 leading-5">
              <span className="shrink-0 font-mono text-aux text-text-tertiary">
                {clockOf(line.created_at)}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-code text-text-primary">
                {line.content}
              </span>
            </p>
          ))}
        </div>
      )}

      {pages < totalPages ? (
        <button
          type="button"
          onClick={() => setPages((value) => value + 1)}
          className="mt-1 text-aux text-primary hover:text-primary-hover"
        >
          加载更早
        </button>
      ) : null}
    </div>
  );
}

function clockOf(value: string | null | undefined): string {
  const text = formatDateTime(value);
  return text === '—' ? '--:--' : text.slice(11, 16);
}
