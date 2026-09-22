import { useMemo, useState } from 'react';
import { Send } from 'lucide-react';
import type { Comment, CommentType } from '@/api';
import { Button, EmptyState, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';
import { AUTHOR_TYPE_LABEL, COMMENT_TYPE_LABEL, labelOf } from '@/lib/labels';
import { formatRelative, parseIso } from '@/lib/time';
import { useAddComment } from '../mutations';
import {
  COMMENTS_PAGE_SIZE,
  DEFAULT_COMMENT_TYPES,
  useTaskCommentPages,
} from '../queries';
import { DayDivider, InlineError, LoadingBlock } from '../ui-bits';
import { LinkifiedText } from '../rich-text';

/**
 * 原型 4.8 评论标签。
 *
 * 三件容易做错的事：
 * 1. **只取 `comment` + `status_change`**（20.8：Agent 只能写 `log`，它属于 4.5 的日志块）。
 *    两类混排会让人以为 Agent 能参与讨论，所以 `log` 默认不在过滤器里，
 *    但保留一个可勾选的开关——排查时想连着日志一起看流水（4.8 取数写明 type 可传）。
 * 2. **服务端是时间倒序**（`GET /tasks/{id}/comments` 按 created_at desc），
 *    界面要的是正序，所以先把已加载页拼起来再整体升序，翻页 = 往更早取。
 * 3. **不发 Markdown**：4.8 明确「纯文本 + 换行，不渲染 Markdown」（描述才渲染），
 *    只做 URL 识别。
 */

const TYPE_OPTIONS: readonly CommentType[] = ['comment', 'status_change', 'log'];

export function CommentsTab({ taskId }: { taskId: string }) {
  const [types, setTypes] = useState<CommentType[]>([...DEFAULT_COMMENT_TYPES]);
  const [pages, setPages] = useState(1);
  const [draft, setDraft] = useState('');
  /** 4.8「成功后本地追加一条，不等 WS 回流」：服务端行回来后按 id 去重丢掉。 */
  const [localRows, setLocalRows] = useState<Comment[]>([]);
  const add = useAddComment(taskId);

  const queries = useTaskCommentPages(taskId, types, pages);
  const first = queries[0];

  const { rows, total } = useMemo(() => {
    const server: Comment[] = [];
    for (const query of queries) {
      for (const item of query.data?.items ?? []) server.push(item);
    }
    const seen = new Set(server.map((item) => item.id));
    const merged = [
      ...server,
      ...localRows.filter((item) => !seen.has(item.id) && types.includes(item.type as CommentType)),
    ];
    return {
      rows: merged.sort((a, b) => timestamp(a.created_at) - timestamp(b.created_at)),
      total: first?.data?.total ?? 0,
    };
  }, [queries, localRows, types, first]);

  const loaded = queries.reduce((sum, query) => sum + (query.data?.items.length ?? 0), 0);
  const hasMore = loaded < total;

  const toggle = (value: CommentType) => {
    setPages(1);
    setTypes((prev) => {
      if (prev.includes(value)) {
        // 全清掉就等于什么都不知道，至少留一类。
        return prev.length === 1 ? prev : prev.filter((item) => item !== value);
      }
      return TYPE_OPTIONS.filter((item) => prev.includes(item) || item === value);
    });
  };

  const send = () => {
    const content = draft.trim();
    if (!content) return;
    add.mutate(
      { content },
      {
        onSuccess: (data) => {
          setLocalRows((prev) => [
            ...prev,
            {
              id: data.id,
              type: 'comment',
              author_type: 'user',
              author_name: '我',
              content,
              run_id: null,
              created_at: new Date().toISOString(),
            },
          ]);
          setDraft('');
        },
      },
    );
  };

  const body = () => {
    if (first?.isPending) return <LoadingBlock lines={3} />;
    if (first?.isError) return <InlineError text={first.error.message} />;
    if (rows.length === 0) {
      return (
        <EmptyState
          title="还没有评论"
          description="状态变更由系统自动记（4.5 文案表），人写的讨论在下面的输入框。"
        />
      );
    }
    const groups = groupByDay(rows);
    return (
      <div className="flex flex-col gap-1">
        {groups.map((group) => (
          <div key={group.day} className="flex flex-col gap-1">
            <DayDivider label={group.label} />
            {group.items.map((item) =>
              item.type === 'status_change' || item.type === 'log' ? (
                <SystemRow key={item.id} comment={item} />
              ) : (
                <PersonRow key={item.id} comment={item} />
              ),
            )}
          </div>
        ))}
        {hasMore ? (
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            loading={queries[pages - 1]?.isPending}
            onClick={() => setPages((value) => value + 1)}
          >
            加载更早
          </Button>
        ) : null}
        <p className="text-aux text-text-tertiary">
          已显示 {rows.length} / {total} 条
        </p>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1.5">
        {TYPE_OPTIONS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={types.includes(value)}
            onClick={() => toggle(value)}
            className={cn(
              'rounded-tag px-2 py-0.5 text-aux transition-colors duration-140 ease-settle',
              types.includes(value)
                ? 'bg-primary-light text-primary'
                : 'bg-bg-muted text-text-secondary hover:text-text-primary',
            )}
          >
            {labelOf(COMMENT_TYPE_LABEL, value)}
          </button>
        ))}
        <span className="ml-auto text-aux text-text-tertiary">每页 {COMMENTS_PAGE_SIZE} 条</span>
      </div>

      {body()}

      <div className="sticky bottom-0 flex items-end gap-2 bg-bg-surface pt-2">
        <Textarea
          value={draft}
          rows={2}
          aria-label="输入评论"
          placeholder="输入评论…（Enter 发送，Shift + Enter 换行）"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />
        <Button
          variant="primary"
          loading={add.isPending}
          disabled={draft.trim() === ''}
          icon={<Send className="size-4" />}
          onClick={send}
        >
          发送
        </Button>
      </div>

      {add.isError ? <InlineError text={add.error.message} /> : null}
    </div>
  );
}

/** 4.8：系统行 12px `--text-tertiary`，无头像、不可回复，文案由服务端生成，前端不拼接。 */
function SystemRow({ comment }: { comment: Comment }) {
  return (
    <p className="flex items-start gap-2 rounded-control px-1 py-0.5 text-aux text-text-tertiary">
      <span className="shrink-0 font-mono">{clockOf(comment.created_at)}</span>
      <span className="shrink-0">{authorOf(comment)}</span>
      <span className="min-w-0 flex-1 break-words" data-selectable>
        <LinkifiedText text={comment.content} />
      </span>
    </p>
  );
}

/** 人行：「我 · 2 小时前」+ 正文（4.8 本期单用户，`user` 恒显示「我」）。 */
function PersonRow({ comment }: { comment: Comment }) {
  return (
    <div className="rounded-card border border-border bg-bg-surface px-3 py-2 shadow-card">
      <p className="mb-1 text-aux text-text-secondary">
        <span className="font-medium text-text-primary">{authorOf(comment)}</span>
        <span className="mx-1 text-text-tertiary">·</span>
        <span title={comment.created_at ?? undefined}>{formatRelative(comment.created_at)}</span>
        {comment.run_id ? (
          <span className="ml-1 font-mono text-text-tertiary">({comment.run_id})</span>
        ) : null}
      </p>
      <p className="whitespace-pre-wrap break-words text-body text-text-primary" data-selectable>
        <LinkifiedText text={comment.content} />
      </p>
    </div>
  );
}

function authorOf(comment: Comment): string {
  if (comment.author_type === 'user') return '我';
  return comment.author_name ?? labelOf(AUTHOR_TYPE_LABEL, comment.author_type);
}

function timestamp(value: string | null): number {
  return parseIso(value)?.getTime() ?? 0;
}

function clockOf(value: string | null): string {
  const date = parseIso(value);
  if (!date) return '--:--';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

interface DayGroup {
  day: string;
  label: string;
  items: Comment[];
}

/** 4.8 的「── 今天 ──」分隔：按本地日切，今天/昨天给中文，其余给 MM-DD。 */
function groupByDay(rows: Comment[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const row of rows) {
    const date = parseIso(row.created_at);
    const day = date ? String(date.toDateString()) : 'unknown';
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.items.push(row);
      continue;
    }
    groups.push({ day, label: dayLabel(date), items: [row] });
  }
  return groups;
}

function dayLabel(date: Date | null): string {
  if (!date) return '未知时间';
  const today = new Date();
  const diffDays = Math.round(
    (new Date(today.toDateString()).getTime() - new Date(date.toDateString()).getTime()) / 86_400_000,
  );
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return date.getFullYear() === today.getFullYear() ? `${mm}-${dd}` : `${date.getFullYear()}-${mm}-${dd}`;
}
