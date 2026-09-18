import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage, qk } from '@/api';
import { cn } from '@/lib/cn';
import { Button, EmptyState, Skeleton } from '@/components/ui';
import type { DiffFileView, DiffHunkView, DiffResultView } from '../types';

/**
 * 原型 9.1 diff 预览：左侧 200px 文件列表可点切换，右侧按 hunk 渲染增删行。
 *
 * 行号与增删都由服务端算好（`GET /artifacts/:id/diff`，`apps/api/src/artifacts/artifact-diff.ts`），
 * 前端**不自己切 hunk**——切法一旦不一致，同一份 patch 在两处显示的行号就会打架。
 * 配色走 1.1 的 token：增行 = `--color-status-done-soft` + 3px `--color-status-done`，
 * 删行 = `--color-status-failed-soft` + 3px `--color-status-failed`（原型 9.1 的十六进制即这两个值）。
 *
 * 里面那层 `max-h-[52vh]` 只负责出滚动条，**不等于折叠**：原型 5.3「diff 区块」的
 * 「超过 200 行折叠 + 展开全部」由调用方用 `collapseAfterLines` 显式开启（9.1 的预览框没有这条，
 * 所以不给默认值），计的是 diff 正文行（add/del/ctx），`@@` 头属版面分隔不算。
 */

const LINE_CLASS: Record<string, string> = {
  add: 'bg-status-done-soft border-l-[3px] border-l-status-done',
  del: 'bg-status-failed-soft border-l-[3px] border-l-status-failed',
  ctx: 'border-l-[3px] border-l-transparent',
};

export interface DiffViewerProps {
  artifactId: string;
  /**
   * 原型 5.3「diff 区块」：当前文件的正文行数超过 N 时先只渲染前 N 行，剩下靠「展开全部」。
   * 不传就一行都不折（9.1 的产物预览框没这条规约，两处共用组件但只有一处受约束）。
   */
  collapseAfterLines?: number;
}

export function DiffViewer({ artifactId, collapseAfterLines }: DiffViewerProps) {
  const query = useQuery({
    queryKey: qk.artifactDiff(artifactId),
    queryFn: async () =>
      (await api.artifacts.diff(artifactId)) as unknown as DiffResultView,
    staleTime: 60_000,
  });

  const files = useMemo(() => query.data?.files ?? [], [query.data]);
  const [selected, setSelected] = useState(0);
  /** 展开态绑「当前显示的是哪一份」而不是一个布尔：refetch 把 `selected` 夹回末尾时，
      上一份的展开态不会被顺带套到另一份上；点选别的文件则直接清空（见下面的 onClick）。 */
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  if (query.isPending) {
    return <Skeleton className="h-64 w-full rounded-card" />;
  }
  if (query.isError) {
    return <EmptyState title="无法解析 diff" description={errorMessage(query.error)} />;
  }
  if (files.length === 0) {
    return <EmptyState title="这份 diff 里没有可展示的片段" />;
  }

  // refetch 后列表可能变短：夹回末尾的 index 同时用于高亮与取文件，否则选中的那一行会没有高亮。
  const activeIndex = Math.min(selected, files.length - 1);
  const active = files[activeIndex] as DiffFileView;
  const activeKey = `${active.path}-${activeIndex}`;

  // 「行数」按用户读到的行数计：只数 diff 正文（add/del/ctx），`@@` 头与二进制提示不占额度。
  const totalLines = active.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  const limit =
    collapseAfterLines !== undefined &&
    collapseAfterLines > 0 &&
    !active.binary &&
    totalLines > collapseAfterLines
      ? collapseAfterLines
      : null;
  const expanded = limit !== null && expandedKey === activeKey;
  const visibleHunks = limit === null || expanded ? active.hunks : firstLines(active.hunks, limit);
  const hiddenLines = limit === null || expanded ? 0 : totalLines - limit;

  return (
    <div className="flex min-h-0 gap-3">
      <ul className="atb-scroll w-[180px] shrink-0 overflow-y-auto rounded-card border border-border bg-bg-muted p-1 win-lg:w-[200px]">
        {files.map((file, index) => (
          <li key={`${file.path}-${index}`}>
            <button
              type="button"
              onClick={() => {
                setSelected(index);
                // 原型 5.3 的折叠是「当前文件」这一层：换文件重新折回前 N 行，
                // 否则上一份的展开态会把这一份直接摊开成几千行。
                setExpandedKey(null);
              }}
              className={cn(
                'flex w-full items-center gap-1 rounded-tag px-2 py-1 text-left text-aux transition-colors duration-120 ease-out',
                index === activeIndex ? 'bg-bg-surface text-text-primary' : 'text-text-secondary hover:bg-bg-surface',
              )}
            >
              <span className="min-w-0 flex-1 truncate" title={file.path}>
                {shortPath(file.path)}
              </span>
              <span className="shrink-0 font-mono text-badge text-status-done">+{file.additions}</span>
              <span className="shrink-0 font-mono text-badge text-status-failed">-{file.deletions}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="min-w-0 flex-1">
        {/* 路径头：悬浮胶囊样式（rounded-badge + bg-surface + shadow-pop，DESIGN §4）。 */}
        <div className="mb-2 flex">
          <div className="flex min-w-0 max-w-full items-baseline gap-2 rounded-badge border border-border bg-bg-surface px-3 py-1 shadow-pop">
            <span className="min-w-0 truncate font-mono text-code text-text-primary" title={active.path}>
              {active.path}
            </span>
            <span className="shrink-0 text-aux tabular-nums text-text-tertiary">
              {active.additions}+ / {active.deletions}-
            </span>
          </div>
        </div>
        {query.data?.truncated ? (
          <p className="mb-1 text-aux text-status-failed">文件超过预览上限，只解析了前一部分。</p>
        ) : null}
        {query.data?.unparsed_lines ? (
          <p className="mb-1 text-aux text-text-tertiary">
            {query.data.unparsed_lines} 行无法解析为 diff 片段，按原文未显示。
          </p>
        ) : null}
        {/* 折叠控件悬浮在滚动框底部（DESIGN §4 悬浮胶囊）：胶囊盖在内容上，
            折叠/展开都留在视线里，不跟内容滚走——与原「按钮放滚动框外面」同一意图。 */}
        <div className="relative">
          <div className="atb-scroll max-h-[52vh] overflow-auto rounded-card border border-border bg-bg-surface">
            {active.binary ? (
              <p className="px-3 py-2 text-aux text-text-tertiary">二进制文件，无文本差异可显示。</p>
            ) : (
              visibleHunks.map((hunk, hunkIndex) => (
                <div key={`${hunk.header}-${hunkIndex}`}>
                  <p className="bg-bg-muted px-3 py-1 font-mono text-code text-text-secondary">
                    {hunk.header}
                  </p>
                  {hunk.lines.map((line, lineIndex) => (
                    <div
                      key={`${line.old_line ?? 'n'}-${line.new_line ?? 'n'}-${lineIndex}`}
                      className={cn('flex items-start font-mono text-code leading-5', LINE_CLASS[line.type])}
                    >
                      <span className="w-10 shrink-0 select-none pr-1 text-right text-text-tertiary">
                        {line.old_line ?? ''}
                      </span>
                      <span className="w-10 shrink-0 select-none border-r border-border pr-1 text-right text-text-tertiary">
                        {line.new_line ?? ''}
                      </span>
                      <span className="min-w-0 flex-1 whitespace-pre px-2 text-text-primary" data-selectable>
                        {line.text}
                      </span>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
          {limit === null ? null : (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3">
              <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-badge border border-border bg-bg-surface px-3 py-1 shadow-pop">
                {/* 折叠时框内只有前 N 行，这条控制要一直可见，不能滚走。 */}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setExpandedKey(expanded ? null : activeKey)}
                >
                  {expanded ? '收起' : '展开全部'}
                </Button>
                <span className="min-w-0 truncate text-aux text-text-tertiary">
                  {expanded
                    ? `共 ${totalLines} 行，已显示全部`
                    : `已折叠 ${hiddenLines} 行（共 ${totalLines} 行，先显示前 ${limit} 行）`}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 文件列表只留末两级，长路径在 200px 里必然只剩 `index.ts`（完整路径在右侧与 title 里）。 */
function shortPath(path: string): string {
  const parts = path.split('/');
  return parts.length <= 2 ? path : parts.slice(-2).join('/');
}

/**
 * 折叠：跨 hunk 连续数正文行，只留前 `limit` 行。
 * 整段被折掉的 hunk 连 `@@` 头一起丢，否则尾部会剩一串没有正文的灰条；
 * 被截断的那个 hunk 仍留头。只做渲染期切片、不碰 `old_line` / `new_line`，
 * 行号一律是服务端算好的那一份。
 */
function firstLines(hunks: DiffHunkView[], limit: number): DiffHunkView[] {
  const kept: DiffHunkView[] = [];
  let remaining = limit;
  for (const hunk of hunks) {
    if (remaining <= 0) break;
    if (hunk.lines.length <= remaining) {
      kept.push(hunk);
      remaining -= hunk.lines.length;
      continue;
    }
    kept.push({ ...hunk, lines: hunk.lines.slice(0, remaining) });
    remaining = 0;
  }
  return kept;
}
