import { useMemo, useState, type ReactNode } from 'react';
import { Checkbox } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * 原型 9.3 文本查看器（`text` / `log` 共用）：行号 + 搜索 + 折叠。
 * 正文由 `useArtifactText` 从一次性签名 URL 读进来（6.10.1），这里只管渲染。
 *
 * 「折叠」按本期能落地的口径实现两件事：超过 `FOLD_AFTER` 行时先渲染前一段并给
 * 「展开全部」；搜索时可只看命中行（命中的上下文靠「仅显示匹配行」开关收放）。
 */

const FOLD_AFTER = 2000;

export interface TextViewerProps {
  text: string;
  /** 高亮关键词由上层（搜索框）驱动。 */
  className?: string;
}

export function TextViewer({ text, className }: TextViewerProps) {
  const [query, setQuery] = useState('');
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const lines = useMemo(() => text.split('\n'), [text]);
  const needle = query.trim().toLowerCase();

  const matches = useMemo(() => {
    if (!needle) return null;
    const set = new Set<number>();
    lines.forEach((line, index) => {
      if (line.toLowerCase().includes(needle)) set.add(index);
    });
    return set;
  }, [lines, needle]);

  const totalMatches = matches ? matches.size : 0;
  const hiddenByFold = !expanded && lines.length > FOLD_AFTER;
  const visible = lines
    .map((line, index) => ({ line, index }))
    .filter(({ index }) => (matches ? !onlyMatches || matches.has(index) : true))
    .slice(0, hiddenByFold ? FOLD_AFTER : undefined);

  return (
    <div className={cn('flex min-h-0 flex-col gap-2', className)}>
      <div className="flex items-center gap-3">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索…"
          aria-label="在产物正文中搜索"
          className="h-8 min-w-0 flex-1 rounded-control border border-border bg-bg-muted px-3 text-body text-text-primary placeholder:text-text-tertiary focus:border-primary focus:bg-bg-surface focus:outline-none"
        />
        <span className="shrink-0 text-aux text-text-tertiary">
          {needle ? `${totalMatches} 处匹配` : `${lines.length} 行`}
        </span>
        {needle ? (
          <Checkbox
            label="仅显示匹配行"
            checked={onlyMatches}
            onChange={(event) => setOnlyMatches(event.target.checked)}
          />
        ) : null}
      </div>
      <div
        className="atb-scroll max-h-[52vh] overflow-auto rounded-card border border-border bg-bg-surface"
        data-selectable
      >
        {visible.length === 0 ? (
          <p className="px-3 py-2 text-aux text-text-tertiary">无匹配行</p>
        ) : (
          visible.map(({ line, index }) => (
            <div key={index} className="flex items-start leading-5 hover:bg-bg-muted">
              <span className="w-12 shrink-0 select-none border-r border-border pr-2 text-right font-mono text-aux text-text-tertiary">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words px-2 font-mono text-code text-text-primary">
                {needle && matches?.has(index) ? highlight(line, needle) : line}
              </span>
            </div>
          ))
        )}
      </div>
      {hiddenByFold ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="self-start text-aux text-primary hover:text-primary-hover"
        >
          展开全部 {lines.length} 行（当前只显示前 {FOLD_AFTER} 行）
        </button>
      ) : null}
    </div>
  );
}

/** 命中片段上色只用 token（1.1 的 primary-light 底），不引高亮库。 */
function highlight(line: string, needle: string): ReactNode {
  const out: ReactNode[] = [];
  const lower = line.toLowerCase();
  let cursor = 0;
  let key = 0;
  while (cursor < line.length) {
    const at = lower.indexOf(needle, cursor);
    if (at < 0) {
      out.push(line.slice(cursor));
      break;
    }
    if (at > cursor) out.push(line.slice(cursor, at));
    out.push(
      <mark key={key++} className="rounded-tag bg-primary-light text-text-primary">
        {line.slice(at, at + needle.length)}
      </mark>,
    );
    cursor = at + needle.length;
  }
  return out;
}
