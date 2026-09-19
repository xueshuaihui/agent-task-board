import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, FileCode2, FileText, FileWarning, Package, Upload, X } from 'lucide-react';
import { Badge, Button, Dialog, useToast } from '@/components/ui';
import { errorMessage } from '@/api';
import { cn } from '@/lib/cn';
import { markdownToBlocks } from './markdown';
import { SKILL_TYPE_META } from './meta';
import { useCreateSkill } from './hooks';
import type { Skill, SkillContent, SkillType } from './types';

/**
 * 统一导入中心（替代单一 .atskill 导入）：拖拽区 + 点击选择，接受
 * .atskill / SKILL.md(.md) / Cursor Rules(.mdc) 多文件，按扩展名分流解析：
 * - .atskill：JSON（导出载荷或完整技能），前端直接解析；
 * - .md / .mdc：markdownToBlocks 前端解析（.mdc 的 Cursor frontmatter 先剥掉，
 *   description 进描述，UI 标注「Cursor Rules」来源）。
 * 解析后进入预览（名称/类型/块数/标签/来源），可改名，确认后统一 POST /skills；
 * 与现有技能重名时提示并给出改名建议；解析失败给出行级错误。
 */

export interface ImportCenterDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (skill: Skill) => void;
  /** 现有技能名列表，用于重名提示与改名建议。 */
  existingNames: string[];
  /** 入口预选（菜单区分 .atskill / SKILL.md / Cursor Rules 进入时提示对应格式）。 */
  initialSource?: SourceKind;
}

type SourceKind = 'atskill' | 'markdown' | 'cursor-rules';

interface ParsedEntry {
  key: string;
  fileName: string;
  source: SourceKind;
  name: string;
  type: SkillType;
  content: SkillContent;
  description: string;
  tags: string[];
  warnings: string[];
}

interface FailedEntry {
  key: string;
  fileName: string;
  message: string;
}

const SOURCE_META: Record<SourceKind, { label: string; className: string }> = {
  atskill: { label: 'atskill', className: 'bg-primary-light text-primary' },
  markdown: { label: 'SKILL.md', className: 'bg-status-ready-soft text-status-ready' },
  'cursor-rules': { label: 'Cursor Rules', className: 'bg-status-review-soft text-status-review' },
};

export function ImportCenterDialog({
  open,
  onClose,
  onImported,
  existingNames,
  initialSource,
}: ImportCenterDialogProps) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [entries, setEntries] = useState<ParsedEntry[]>([]);
  const [failed, setFailed] = useState<FailedEntry[]>([]);

  const create = useCreateSkill((skill) => {
    toast.success('导入成功', `已创建技能「${skill.name}」`);
  });

  /* 每次打开重置上一次的解析结果。 */
  useEffect(() => {
    if (open) {
      setEntries([]);
      setFailed([]);
      setDragOver(false);
    }
  }, [open]);

  const addFiles = useCallback(
    async (files: File[]) => {
      const nextEntries: ParsedEntry[] = [];
      const nextFailed: FailedEntry[] = [];
      for (const file of files) {
        const lower = file.name.toLowerCase();
        try {
          const text = await file.text();
          if (lower.endsWith('.atskill')) {
            nextEntries.push(parseAtskill(file.name, text));
          } else if (lower.endsWith('.mdc')) {
            nextEntries.push(parseCursorRules(file.name, text));
          } else if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
            nextEntries.push(parseMarkdown(file.name, text, 'markdown'));
          } else {
            nextFailed.push({
              key: `${file.name}-ext`,
              fileName: file.name,
              message: '不支持的文件类型：仅接受 .atskill / .md / .mdc',
            });
          }
        } catch (error) {
          nextFailed.push({
            key: `${file.name}-parse`,
            fileName: file.name,
            message: errorMessage(error) || '解析失败',
          });
        }
      }
      setEntries((prev) => [...prev, ...nextEntries]);
      setFailed((prev) => [...prev, ...nextFailed]);
    },
    [],
  );

  /* 重名检测：与库中已有技能或本批已加条目同名。 */
  const takenNames = useMemo(
    () => new Set([...existingNames, ...entries.map((entry) => entry.name.trim())]),
    [existingNames, entries],
  );

  const duplicateKeys = useMemo(() => {
    const seen = new Set<string>(existingNames);
    const dup = new Set<string>();
    for (const entry of entries) {
      const name = entry.name.trim();
      if (seen.has(name)) dup.add(entry.key);
      seen.add(name);
    }
    return dup;
  }, [entries, existingNames]);

  const renameEntry = (key: string, name: string) => {
    setEntries((prev) => prev.map((entry) => (entry.key === key ? { ...entry, name } : entry)));
  };

  const removeEntry = (key: string) => {
    setEntries((prev) => prev.filter((entry) => entry.key !== key));
    setFailed((prev) => prev.filter((entry) => entry.key !== key));
  };

  const suggestName = (base: string): string => {
    let candidate = `${base}-2`;
    let index = 2;
    while (takenNames.has(candidate)) {
      index += 1;
      candidate = `${base}-${index}`;
    }
    return candidate;
  };

  /**
   * 逐个创建：单个文件失败不中断整批（失败项转成行级错误留在对话框里），
   * 整批处理完才交给父级关闭对话框。
   */
  const confirmImport = () => {
    const queue = [...entries];
    let created: Skill | null = null;
    const step = (index: number) => {
      if (index >= queue.length) {
        if (created) onImported(created);
        return;
      }
      const entry = queue[index];
      const drop = () => setEntries((prev) => prev.filter((item) => item.key !== entry.key));
      create.mutate(
        {
          name: entry.name.trim(),
          type: entry.type,
          description: entry.description,
          tags: entry.tags,
          content: entry.content,
        },
        {
          onSuccess: (skill) => {
            created = skill;
            drop();
            step(index + 1);
          },
          onError: (error) => {
            drop();
            setFailed((prev) => [
              ...prev,
              {
                key: `${entry.key}-create`,
                fileName: entry.fileName,
                message: `创建失败：${errorMessage(error) || '未知错误'}`,
              },
            ]);
            step(index + 1);
          },
        },
      );
    };
    step(0);
  };

  const hasValid = entries.length > 0;
  const allValid = hasValid && failed.length === 0 && duplicateKeys.size === 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="导入技能"
      footer={
        <>
          <Button variant="default" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!hasValid || !allValid}
            loading={create.isPending}
            onClick={confirmImport}
          >
            {hasValid ? `创建 ${entries.length} 个技能` : '创建'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* 拖拽区：原生 dragover/drop，悬停高亮。 */}
        <div
          role="button"
          tabIndex={0}
          aria-label="导入文件拖拽区"
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            void addFiles(Array.from(event.dataTransfer.files));
          }}
          className={cn(
            'flex cursor-pointer flex-col items-center gap-2 rounded-card border border-dashed px-6 py-8 text-center transition-colors',
            dragOver
              ? 'border-primary bg-primary-light/50'
              : 'border-border bg-bg-surface hover:border-primary/60 hover:bg-bg-raised',
          )}
        >
          <Upload className={cn('size-6', dragOver ? 'text-primary' : 'text-text-tertiary')} />
          <p className="text-body text-text-primary">
            {dragOver ? '松开即可解析' : '拖拽文件到此处，或点击选择'}
          </p>
          <p className="text-aux text-text-tertiary">
            {initialSource === 'atskill'
              ? '选择 .atskill（JSON）技能文件，可多选'
              : initialSource === 'cursor-rules'
                ? '选择 Cursor Rules 的 .mdc 文件，可多选'
                : initialSource === 'markdown'
                  ? '选择 SKILL.md 或 .md 技能文档，可多选'
                  : '支持 .atskill / SKILL.md / .md / Cursor Rules .mdc，可多选'}
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".atskill,.md,.markdown,.mdc"
            className="hidden"
            onChange={(event) => {
              void addFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
        </div>

        {/* 解析失败列表：行级错误。 */}
        {failed.map((entry) => (
          <div
            key={entry.key}
            className="flex items-start gap-2 rounded-card border border-status-failed/40 bg-status-failed-soft px-3 py-2"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-status-failed" />
            <div className="min-w-0 flex-1">
              <p className="text-body text-text-primary">{entry.fileName}</p>
              <p className="text-aux text-status-failed">{entry.message}</p>
            </div>
            <button
              type="button"
              aria-label={`移除 ${entry.fileName}`}
              onClick={() => removeEntry(entry.key)}
              className="text-text-tertiary hover:text-text-primary"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}

        {/* 解析预览列表。 */}
        {entries.map((entry) => {
          const duplicate = duplicateKeys.has(entry.key);
          return (
            <div key={entry.key} className="rounded-card border border-border bg-bg-surface p-3">
              <div className="flex items-start gap-2">
                <SourceIcon source={entry.source} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge>{SKILL_TYPE_META[entry.type]?.label ?? entry.type}</Badge>
                    <span className={cn('rounded-badge px-2 py-0.5 text-badge', SOURCE_META[entry.source].className)}>
                      {SOURCE_META[entry.source].label}
                    </span>
                    <span className="text-aux text-text-tertiary">{entry.content.blocks.length} 个块</span>
                    {entry.tags.map((tag) => (
                      <span key={tag} className="rounded-badge bg-bg-muted px-1.5 py-0.5 text-badge text-text-tertiary">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      value={entry.name}
                      aria-label="技能名称"
                      onChange={(event) => renameEntry(entry.key, event.target.value)}
                      className={cn(
                        'h-7 w-56 rounded-control border bg-bg-surface px-2 text-body text-text-primary outline-none focus:border-primary',
                        (duplicate || entry.name.trim().length === 0) && 'border-status-failed',
                      )}
                    />
                    {duplicate ? (
                      <span className="text-aux text-status-failed">
                        与现有技能重名，建议改为「{suggestName(entry.name.trim() || 'skill')}」
                      </span>
                    ) : null}
                  </div>
                  {entry.description ? (
                    <p className="mt-1 line-clamp-2 text-aux text-text-secondary">{entry.description}</p>
                  ) : null}
                  {entry.warnings.map((warning) => (
                    <p key={warning} className="mt-1 flex items-center gap-1 text-aux text-status-review">
                      <FileWarning className="size-3.5 shrink-0" />
                      {warning}
                    </p>
                  ))}
                </div>
                <button
                  type="button"
                  aria-label={`移除 ${entry.fileName}`}
                  onClick={() => removeEntry(entry.key)}
                  className="text-text-tertiary hover:text-text-primary"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>
          );
        })}

        {entries.length === 0 && failed.length === 0 ? (
          <p className="text-center text-aux text-text-tertiary">
            解析完全在前端完成：预览名称、类型与块数后再创建，不会直接写入。
          </p>
        ) : null}
        {failed.length > 0 ? (
          <p className="flex items-center gap-1 text-aux text-status-failed">
            <AlertCircle className="size-3.5" />
            存在失败的文件，请先移除或修正后再创建
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function SourceIcon({ source }: { source: SourceKind }) {
  const className = 'mt-0.5 size-4 shrink-0 text-text-secondary';
  if (source === 'atskill') return <Package className={className} />;
  if (source === 'cursor-rules') return <FileCode2 className={className} />;
  return <FileText className={className} />;
}

/* --------------------------------- 解析器 --------------------------------- */

let importKey = 0;
function nextKey(): string {
  importKey += 1;
  return `import-${Date.now().toString(36)}-${importKey}`;
}

/** .atskill：导出载荷 {name,type,content,...} 或完整 Skill JSON。 */
function parseAtskill(fileName: string, text: string): ParsedEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON 解析失败：${error instanceof Error ? error.message : '格式不合法'}`);
  }
  const payload = parsed as {
    name?: string;
    type?: SkillType;
    content?: SkillContent;
    description?: string;
    tags?: string[];
    blocks?: SkillContent['blocks'];
    entryBlockId?: string | null;
  };
  const content: SkillContent | undefined =
    payload.content ??
    (Array.isArray(payload.blocks)
      ? { blocks: payload.blocks, entryBlockId: payload.entryBlockId ?? payload.blocks[0]?.id ?? null }
      : undefined);
  if (!content || !Array.isArray(content.blocks)) {
    throw new Error('缺少 content.blocks 字段，不是合法的 .atskill 技能文件');
  }
  if (content.blocks.length === 0) {
    throw new Error('技能内容为空（blocks 为空数组）');
  }
  return {
    key: nextKey(),
    fileName,
    source: 'atskill',
    // 名称优先取文件里的 `name`：导出的文件名是技能 ID（`skl_xxx.atskill`），
    // 只按文件名起名会让「导出再导入」得到一个 ID 名字的技能。
    name: payload.name?.trim() || stripExtension(fileName, '.atskill'),
    type: isSkillType(payload.type) ? payload.type : 'prompt',
    content,
    description: payload.description ?? '',
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    warnings: [],
  };
}

/** SKILL.md / .md：markdownToBlocks 前端解析。 */
function parseMarkdown(fileName: string, text: string, source: SourceKind): ParsedEntry {
  const result = markdownToBlocks(text);
  if (result.content.blocks.length === 0) {
    throw new Error('没有解析出任何内容块：正文需要「### 块标题」小节');
  }
  const name = result.frontmatter?.name?.trim() || stripExtension(fileName, '.md');
  return {
    key: nextKey(),
    fileName,
    source,
    name,
    type: source === 'cursor-rules' ? 'prompt' : guessType(result),
    content: result.content,
    description: result.frontmatter?.description?.trim() ?? '',
    tags: result.frontmatter?.tags ?? [],
    warnings: [...result.warnings],
  };
}

/** Cursor Rules .mdc：剥 Cursor frontmatter（description/globs/alwaysApply）再走同一 markdown 转换。 */
function parseCursorRules(fileName: string, text: string): ParsedEntry {
  let body = text;
  let description = '';
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (fm) {
    body = text.slice(fm[0].length);
    const descLine = fm[1].split('\n').find((line) => line.startsWith('description:'));
    description = descLine ? descLine.slice('description:'.length).trim() : '';
  }
  /* Cursor Rules 正文没有 ### 小节时整体作为一个提示词块导入。 */
  const normalized = body.includes('### ')
    ? body
    : ['---', `name: ${stripExtension(fileName, '.mdc')}`, `description: ${description.replace(/\n/g, ' ')}`, '---', '', `### 规则`, '', `<!-- atb:prompt -->`, '', body.trim()].join('\n');
  const parsed = parseMarkdown(fileName, normalized, 'cursor-rules');
  parsed.name = stripExtension(fileName, '.mdc');
  parsed.description = description || parsed.description;
  parsed.warnings = ['Cursor Rules 按「提示词块」整体导入，可在编辑器中拆分为多个块', ...parsed.warnings];
  return parsed;
}

function stripExtension(name: string, ext: string): string {
  const lower = name.toLowerCase();
  return lower.endsWith(ext) ? name.slice(0, -ext.length) : name;
}

function isSkillType(value: unknown): value is SkillType {
  return typeof value === 'string' && value in SKILL_TYPE_META;
}

/** 无 frontmatter 类型信息时按块形状粗略推断类型。 */
function guessType(result: ReturnType<typeof markdownToBlocks>): SkillType {
  const blocks = result.content.blocks;
  if (blocks.some((block) => block.kind === 'decision' || block.kind === 'loop')) return 'flow';
  if (blocks.some((block) => block.kind === 'subskill')) return 'composite';
  if (blocks.some((block) => block.kind === 'step')) return 'steps';
  if (blocks.some((block) => block.kind === 'script')) return 'script';
  return 'prompt';
}
