import { useEffect, useRef, useState } from 'react';
import { Download, FileUp } from 'lucide-react';
import { Button, useToast } from '@/components/ui';
import { MARKDOWN_CONVENTION_HINT, blocksToMarkdown, markdownToBlocks } from './markdown';
import type { SkillFrontmatter } from './markdown';
import type { SkillContent } from './types';

/**
 * 源码模式（1.md 8.3，高级用户）：左侧 SKILL.md 源码编辑，右侧实时预览。
 * 「导出 SKILL.md」把当前 blocks 转成 Markdown（写入左侧可继续编辑），
 * 「从 SKILL.md 导入」把左侧 Markdown 转回 blocks（损失性转换会弹出提示）。
 * 转换纯函数在 markdown.ts，约定见该文件末尾注释块。
 */

export interface SourceEditorProps {
  content: SkillContent;
  frontmatter: SkillFrontmatter;
  /** 导入成功后回写 blocks（与 frontmatter 变更）；warnings 由本组件 Toast。 */
  onImport: (content: SkillContent, frontmatter: SkillFrontmatter) => void;
}

export function SourceEditor({ content, frontmatter, onImport }: SourceEditorProps) {
  const toast = useToast();
  const [md, setMd] = useState(() => blocksToMarkdown(content, frontmatter));
  const [dirty, setDirty] = useState(false);
  const lastSyncRef = useRef(content);

  // 其他模式改了 blocks（引用变化）→ 重新导出到左侧。导入回写的内容不重复生成。
  useEffect(() => {
    if (content !== lastSyncRef.current) {
      lastSyncRef.current = content;
      setMd(blocksToMarkdown(content, frontmatter));
      setDirty(false);
    }
  }, [content, frontmatter]);

  const exportMarkdown = () => {
    setMd(blocksToMarkdown(content, frontmatter));
    lastSyncRef.current = content;
    setDirty(false);
    toast.success('已按当前内容重新生成 SKILL.md');
  };

  const importMarkdown = () => {
    const result = markdownToBlocks(md);
    lastSyncRef.current = result.content;
    onImport(result.content, result.frontmatter ?? frontmatter);
    if (result.warnings.length > 0) {
      toast.warning('导入完成，有损失性转换', result.warnings.join('；'));
    } else {
      toast.success('导入完成', 'blocks 已同步，可在可视化/结构化模式检查');
    }
  };

  const downloadMarkdown = () => {
    const blob = new Blob([md], { type: 'text/markdown' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${frontmatter.name || 'skill'}.SKILL.md`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<FileUp className="size-4" />} onClick={importMarkdown}>
          从 SKILL.md 导入
        </Button>
        <Button size="sm" variant="default" icon={<Download className="size-4" />} onClick={exportMarkdown}>
          导出 SKILL.md
        </Button>
        <Button size="sm" variant="ghost" onClick={downloadMarkdown}>
          下载 .md 文件
        </Button>
        {dirty ? <span className="text-aux text-text-tertiary">源码有未导入修改（预览实时，blocks 需导入）</span> : null}
        <span className="ml-auto max-w-md text-aux text-text-tertiary">{MARKDOWN_CONVENTION_HINT}</span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
        <textarea
          value={md}
          spellCheck={false}
          className="atb-scroll h-full min-h-[360px] w-full resize-none rounded-card border border-border bg-bg p-3 font-mono text-code leading-relaxed text-text-primary outline-none focus:border-primary"
          aria-label="SKILL.md 源码"
          onChange={(event) => {
            setMd(event.target.value);
            setDirty(true);
          }}
        />
        <MarkdownPreview source={md} />
      </div>
    </div>
  );
}

/** 轻量 Markdown 预览（标题/列表/代码块/段落 + {{变量}} 高亮），不引依赖。 */
export function MarkdownPreview({ source }: { source: string }) {
  const lines = source.split('\n');
  const rendered: React.ReactNode[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let key = 0;

  const inline = (text: string) =>
    text.split(/(\{\{[^}]+\}\})/g).map((part, index) =>
      /^\{\{[^}]+\}\}$/.test(part) ? (
        <code key={index} className="rounded-tag bg-primary-light px-1 font-mono text-primary">
          {part}
        </code>
      ) : (
        <span key={index}>{part}</span>
      ),
    );

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        rendered.push(
          <pre key={key++} className="atb-scroll overflow-x-auto rounded-card border border-border bg-bg p-2 font-mono text-code text-text-secondary">
            {codeLines.join('\n')}
          </pre>,
        );
        inCode = false;
        codeLines = [];
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (/^---$/.test(line.trim()) || line.trim() === '') {
      continue;
    }
    const heading = /^(#{1,4}) (.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      rendered.push(
        <p
          key={key++}
          className={
            level <= 2
              ? 'text-section-title text-text-primary'
              : level === 3
                ? 'text-card-title text-text-primary'
                : 'text-body text-text-secondary'
          }
        >
          {inline(heading[2])}
        </p>,
      );
      continue;
    }
    const list = /^[-*] (.+)$/.exec(line) ?? /^\d+\. (.+)$/.exec(line);
    if (list) {
      rendered.push(
        <p key={key++} className="flex gap-2 pl-3 text-body text-text-secondary">
          <span className="text-text-tertiary">·</span>
          <span>{inline(list[1])}</span>
        </p>,
      );
      continue;
    }
    if (line.startsWith('<!--')) continue;
    rendered.push(
      <p key={key++} className="text-body text-text-secondary">
        {inline(line)}
      </p>,
    );
  }

  return (
    <div className="atb-scroll h-full min-h-[360px] overflow-y-auto rounded-card border border-border bg-bg-raised p-4">
      <div className="flex flex-col gap-2">{rendered}</div>
    </div>
  );
}
