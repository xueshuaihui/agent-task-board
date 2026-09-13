import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * PRD 6.1 第 2 条：任务描述支持 Markdown 渲染；4.8 明确**评论不渲染 Markdown**（只自动识别 URL）。
 *
 * 文档里点名的实现是 `react-markdown`，但本期禁止 `npm install`，所以在这里落一个
 * 不引依赖的**受限子集**渲染器：标题 / 有序无序列表 / 围栏代码块 / 引用 / 粗斜体 /
 * 行内代码 / 链接 / 裸 URL。全部走 React 节点拼装，不用 `dangerouslySetInnerHTML`
 * ——15 章的口径是「Agent 上传的内容不能被当脚本执行」，人写的描述同理。
 *
 * TODO(主 agent)：装上 `react-markdown` 后，把 `MarkdownLite` 换成它即可，调用点不用改。
 */

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

export function LinkifiedText({ text, className }: { text: string; className?: string }) {
  return <span className={className}>{inlineTokens(text)}</span>;
}

function inlineTokens(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let key = 0;
  // 先按 `code` 切，代码里的 URL 不该变成链接。
  for (const part of text.split(/(`[^`\n]+`)/)) {
    if (part === '') continue;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      nodes.push(
        <code key={key++} className="rounded-tag bg-bg-muted px-1 py-px font-mono text-code">
          {part.slice(1, -1)}
        </code>,
      );
      continue;
    }
    for (const chunk of part.split(URL_RE)) {
      if (chunk === '') continue;
      if (/^https?:\/\//i.test(chunk)) {
        nodes.push(
          <a
            key={key++}
            href={chunk}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-primary hover:text-primary-hover hover:underline"
          >
            {chunk}
          </a>,
        );
        continue;
      }
      nodes.push(...emphasis(chunk, key));
      key += 1000;
    }
  }
  return nodes;
}

/** `**粗体**` / `*斜体*`：一层嵌套都不支持，够描述里写「**必须**回归这两条用例」这种程度。 */
function emphasis(text: string, seed: number): ReactNode[] {
  const out: ReactNode[] = [];
  let key = seed;
  const pattern = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) out.push(text.slice(cursor, match.index));
    const token = match[0];
    out.push(
      token.startsWith('**') ? (
        <strong key={key++} className="font-semibold">
          {token.slice(2, -2)}
        </strong>
      ) : (
        <em key={key++}>{token.slice(1, -1)}</em>
      ),
    );
    cursor = match.index + token.length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

export function MarkdownLite({ text, className }: { text: string; className?: string }) {
  return <div className={cn('flex flex-col gap-2 text-body text-text-primary', className)}>{renderBlocks(text)}</div>;
}

function renderBlocks(source: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // 围栏代码块
    if (/^```/.test(line)) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre
          key={key++}
          data-selectable
          className="atb-scroll overflow-auto rounded-card border border-border bg-bg-muted p-3 font-mono text-code leading-5"
        >
          {body.join('\n')}
        </pre>,
      );
      continue;
    }

    // 标题
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? '#').length;
      blocks.push(
        <p
          key={key++}
          className={cn(
            'font-semibold text-text-primary',
            level <= 2 ? 'text-card-title' : 'text-body',
          )}
        >
          {inlineTokens(heading[2] ?? '')}
        </p>,
      );
      index += 1;
      continue;
    }

    // 列表
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (index < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        index += 1;
      }
      const ListTag = ordered ? 'ol' : 'ul';
      blocks.push(
        <ListTag
          key={key++}
          className={cn('flex flex-col gap-1 pl-5', ordered ? 'list-decimal' : 'list-disc')}
        >
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{inlineTokens(item)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote
          key={key++}
          className="border-l-[3px] border-border-strong bg-bg-muted px-3 py-2 text-text-secondary"
        >
          {inlineTokens(quoted.join(' '))}
        </blockquote>,
      );
      continue;
    }

    // 段落：吃到下一个空行为止
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() !== '' &&
      !/^```/.test(lines[index] ?? '') &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[index] ?? '') &&
      !/^>\s?/.test(lines[index] ?? '') &&
      !/^(#{1,4})\s+/.test(lines[index] ?? '')
    ) {
      paragraph.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push(
      <p key={key++} className="whitespace-pre-wrap break-words">
        {inlineTokens(paragraph.join('\n'))}
      </p>,
    );
  }

  return blocks;
}
