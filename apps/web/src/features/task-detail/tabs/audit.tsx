import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button, EmptyState } from '@/components/ui';
import { cn } from '@/lib/cn';
import { AUDIT_ACTION_LABEL, AUTHOR_TYPE_LABEL, labelOf } from '@/lib/labels';
import { formatDateTime, parseIso } from '@/lib/time';
import { AUDIT_PAGE_SIZE, useTaskAuditPages } from '../queries';
import type { AuditEntryView } from '../types';
import { InlineError, LoadingBlock, Mono, Section } from '../ui-bits';

/**
 * 原型 4.10 审计标签：与设置页「日志与审计」下半区（7.7）同构，只带 `target_id`。
 *
 * 三条硬规则：
 * - **四列，不列「对象」**：本标签里对象恒等于当前任务，占了宽度不给信息。
 * - 动作显示 20.2 的**枚举原值** + 旁边一个中文注释，不做「翻译后的第三种叫法」；
 *   表外值按 20.2 渲染「未知（原值）」（`labelOf` 已经这么干）。
 * - 详情 = `before` → `after` 的压缩摘要，点击展开两份 JSON 原文。
 *
 * 这里不提供任何「清理」「编辑」入口（6.8 审计只能追加）。
 */

export function AuditTab({ taskId }: { taskId: string }) {
  const [pages, setPages] = useState(1);
  const queries = useTaskAuditPages(taskId, pages);
  const first = queries[0];

  const { rows, total } = useMemo(() => {
    const items: AuditEntryView[] = [];
    const seen = new Set<number>();
    for (const query of queries) {
      for (const item of query.data?.items ?? []) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }
    }
    // 服务端时间倒序（4.10），拼页后仍按倒序渲染，最新在上。
    items.sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at));
    return { rows: items, total: first?.data?.total ?? 0 };
  }, [queries, first]);

  const loaded = queries.reduce((sum, query) => sum + (query.data?.items.length ?? 0), 0);

  if (first?.isPending) return <LoadingBlock lines={4} />;
  if (first?.isError) return <InlineError text={first.error.message} />;

  return (
    <Section title="操作记录" meta={`共 ${total} 条`}>
      {rows.length === 0 ? (
        <EmptyState title="没有审计记录" description="该任务还没有产生写操作流水（6.8）。" />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-bg-surface">
          {rows.map((row) => (
            <AuditRow key={row.id} row={row} />
          ))}
        </ul>
      )}

      {loaded < total ? (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            loading={queries[pages - 1]?.isPending}
            onClick={() => setPages((value) => value + 1)}
          >
            加载更多
          </Button>
          <span className="text-aux text-text-tertiary">
            每页 {AUDIT_PAGE_SIZE} 条 · 已加载 {loaded}
          </span>
        </div>
      ) : null}
    </Section>
  );
}

function AuditRow({ row }: { row: AuditEntryView }) {
  const [open, setOpen] = useState(false);
  const summary = summarize(row.before, row.after);
  const hasRaw = row.before !== null || row.after !== null;

  return (
    <li className="px-3 py-2">
      <button
        type="button"
        disabled={!hasRaw}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex w-full items-start gap-2 text-left',
          hasRaw ? 'cursor-pointer hover:bg-bg-muted' : 'cursor-default',
        )}
        aria-expanded={hasRaw ? open : undefined}
      >
        <span
          className="w-[92px] shrink-0 text-aux text-text-secondary"
          title={formatDateTime(row.created_at)}
        >
          {shortDateTime(row.created_at)}
        </span>
        <span className="w-[68px] shrink-0 truncate text-aux text-text-secondary" title={actorOf(row)}>
          {actorOf(row)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            {hasRaw ? (
              open ? (
                <ChevronDown className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
              )
            ) : null}
            <Mono className="shrink-0">{row.action}</Mono>
            <span className="truncate text-aux text-text-tertiary">
              {labelOf(AUDIT_ACTION_LABEL, row.action)}
            </span>
          </span>
          <span className="mt-0.5 block break-words text-aux text-text-primary" data-selectable>
            {summary || '—'}
          </span>
        </span>
      </button>

      {open && hasRaw ? (
        <div className="mt-2 flex flex-col gap-2">
          <JsonBlock label="before" value={row.before} />
          <JsonBlock label="after" value={row.after} />
        </div>
      ) : null}
    </li>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) {
    return (
      <p className="text-aux text-text-tertiary">
        {label}：—
      </p>
    );
  }
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // 手改过的坏行（7.7 明确要求不炸整页）：原样贴出来。
    text = String(value);
  }
  return (
    <div>
      <p className="mb-1 text-aux text-text-tertiary">{label}</p>
      <pre
        data-selectable
        className="atb-scroll max-h-[220px] overflow-auto rounded-control bg-bg-muted p-2 font-mono text-code leading-[18px] text-text-primary"
      >
        {text}
      </pre>
    </div>
  );
}

/**
 * before → after 的压缩摘要（4.10 的「详情」列）。
 *
 * 只挑**发生变化**的键，两侧都有的键比原值，单边才有的按 `→ 值`；
 * 一次最多列 4 项，多余的下钻到展开的 JSON 里看。
 */
function summarize(before: unknown, after: unknown): string {
  const from = asRecord(before);
  const to = asRecord(after);
  if (!from && !to) {
    const raw = before ?? after;
    return raw === null || raw === undefined ? '' : shortValue(raw);
  }
  const keys = [...new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})])];
  const parts: string[] = [];
  for (const key of keys) {
    const oldValue = from?.[key];
    const newValue = to?.[key];
    if (oldValue === undefined && newValue !== undefined) {
      parts.push(`${key}: → ${shortValue(newValue)}`);
      continue;
    }
    if (oldValue !== undefined && newValue === undefined) {
      parts.push(`${key}: ${shortValue(oldValue)} → —`);
      continue;
    }
    if (sameValue(oldValue, newValue)) continue;
    parts.push(`${shortValue(oldValue)} → ${shortValue(newValue)}`);
  }
  if (parts.length === 0) return '无字段变化';
  return parts.length > 4 ? `${parts.slice(0, 4).join(' · ')} · +${parts.length - 4}` : parts.join(' · ');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    // 7.7：库里是 JSON 文本，服务端已经解过一层；坏行留在这里兜一手。
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
}

function shortValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') {
    const text = JSON.stringify(value);
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  }
  const text = String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** 操作者：服务端 `actor_label` 优先（20.8 口径由它定死），缺失才退回本地映射。 */
function actorOf(row: AuditEntryView): string {
  if (row.actor_label) return row.actor_label;
  if (row.actor_type === 'user') return '我';
  return row.actor_name ?? labelOf(AUTHOR_TYPE_LABEL, row.actor_type);
}

/** 4.10 的时间列只有 `09-11 14:30`：抽屉里同一年内重复年份不给信息。 */
function shortDateTime(value: string | null): string {
  const date = parseIso(value);
  if (!date) return '—';
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function timestamp(value: string | null): number {
  return parseIso(value)?.getTime() ?? 0;
}

/** 展开态给绝对时间，避免跨年的记录在 `09-11` 上互相混淆。 */
export function auditAbsoluteTime(value: string | null): string {
  return formatDateTime(value);
}
