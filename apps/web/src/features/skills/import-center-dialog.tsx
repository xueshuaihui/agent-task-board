import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, FileCode2, FileText, FileWarning, Package, Upload, X } from 'lucide-react';
import { Badge, Button, Dialog, useToast } from '@/components/ui';
import { errorMessage } from '@/api';
import { cn } from '@/lib/cn';
import { markdownToBlocks } from './markdown';
import { skillsApi } from './api';
import { SKILL_TYPE_META } from './meta';
import type { Skill, SkillContent, SkillImportConflict, SkillType } from './types';

/**
 * 统一导入中心（v0.0.4 W2 口径，§9.8）：拖拽区 + 点击选择，接受
 * .atskill / SKILL.md(.md) / Cursor Rules(.mdc) 多文件，前端解析仅做预览；
 * 确认导入一律走后端 /skills/import（multipart）与 /skills/import-markdown，
 * 保证落库 source=imported（三方技能）。
 *
 * r2 冲突语义：同名不是冲突（直接共存、列表消歧）；按技能 `id` 判冲突——
 * 同 ID（已存在）默认「覆盖更新为新版本」，可切换「跳过」（§9.8.4/§20.5-17）。
 * 名称等元数据以文件为准，预览不提供改名。
 */

export interface ImportCenterDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (skill: Skill) => void;
  /** 库内现有技能：同 ID 冲突判定与同名共存提示的数据源。 */
  existingSkills: Skill[];
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
  /** 文件声明的技能 id（§9.2 r2；旧文件可能没有）。 */
  fileId: string | null;
  /** 原文件与文本：确认导入时原样交给后端解析落库。 */
  file: File;
  text: string;
  /** 同 ID 冲突的处置选择（默认覆盖更新）。 */
  strategy: Exclude<SkillImportConflict, 'fail'>;
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
  existingSkills,
  initialSource,
}: ImportCenterDialogProps) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [entries, setEntries] = useState<ParsedEntry[]>([]);
  const [failed, setFailed] = useState<FailedEntry[]>([]);
  const [busy, setBusy] = useState(false);

  const existingById = useMemo(
    () => new Map(existingSkills.map((skill) => [skill.id, skill])),
    [existingSkills],
  );
  const existingNames = useMemo(
    () => new Set(existingSkills.map((skill) => skill.name)),
    [existingSkills],
  );

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
            nextEntries.push(parseAtskill(file, text));
          } else if (lower.endsWith('.mdc')) {
            nextEntries.push(parseCursorRules(file, text));
          } else if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
            nextEntries.push(parseMarkdown(file, text, 'markdown'));
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

  const setStrategy = (key: string, strategy: ParsedEntry['strategy']) => {
    setEntries((prev) => prev.map((entry) => (entry.key === key ? { ...entry, strategy } : entry)));
  };

  const removeEntry = (key: string) => {
    setEntries((prev) => prev.filter((entry) => entry.key !== key));
    setFailed((prev) => prev.filter((entry) => entry.key !== key));
  };

  /**
   * 逐个导入：全部走后端导入端点（source=imported、同 ID 冲突按策略处置）；
   * 「跳过」的同 ID 行不发请求、静默移除（§9.8.4：跳过=原技能不动）。
   * 单个文件失败不中断整批（失败项转行级错误留在对话框里）。
   */
  const confirmImport = async () => {
    const queue = [...entries];
    let last: Skill | null = null;
    setBusy(true);
    for (const entry of queue) {
      const drop = () => setEntries((prev) => prev.filter((item) => item.key !== entry.key));
      if (entry.fileId && existingById.has(entry.fileId) && entry.strategy === 'skip') {
        drop();
        continue;
      }
      const conflict = entry.fileId && existingById.has(entry.fileId);
      try {
        const skill =
          entry.source === 'atskill'
            ? await skillsApi.import(entry.file, conflict ? entry.strategy : undefined)
            : await skillsApi.importMarkdown(
                { filename: entry.fileName, content: entry.text },
                conflict ? entry.strategy : undefined,
              );
        last = skill;
        drop();
      } catch (error) {
        drop();
        setFailed((prev) => [
          ...prev,
          {
            key: `${entry.key}-create`,
            fileName: entry.fileName,
            message: `导入失败：${errorMessage(error) || '未知错误'}`,
          },
        ]);
      }
    }
    setBusy(false);
    if (last) {
      toast.success('导入成功', `已导入技能「${last.name}」（三方技能）`);
      onImported(last);
    }
  };

  const hasValid = entries.length > 0;
  const allValid = hasValid && failed.length === 0;

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
            loading={busy}
            onClick={() => void confirmImport()}
          >
            {hasValid ? `导入 ${entries.length} 个技能` : '导入'}
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
          const existing = entry.fileId ? existingById.get(entry.fileId) : undefined;
          const nameNote = !existing && existingNames.has(entry.name.trim());
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
                    {entry.fileId ? (
                      <span className="rounded-badge bg-bg-muted px-1.5 py-0.5 text-badge text-text-tertiary" title="技能唯一 ID（r2）">
                        {entry.fileId}
                      </span>
                    ) : null}
                    {entry.tags.map((tag) => (
                      <span key={tag} className="rounded-badge bg-bg-muted px-1.5 py-0.5 text-badge text-text-tertiary">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <p className="mt-1 text-body text-text-primary">{entry.name}</p>
                  {existing ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 text-aux text-status-review">
                        <AlertCircle className="size-3.5" />
                        同 ID（已存在「{existing.name}」，当前 {existing.current_version}）
                      </span>
                      {/* §9.8.3：覆盖更新为新版本（默认）/ 跳过。 */}
                      <label className="inline-flex items-center gap-1 text-aux text-text-secondary">
                        <input
                          type="radio"
                          name={`conflict-${entry.key}`}
                          checked={entry.strategy === 'overwrite'}
                          onChange={() => setStrategy(entry.key, 'overwrite')}
                        />
                        覆盖更新为新版本
                      </label>
                      <label className="inline-flex items-center gap-1 text-aux text-text-secondary">
                        <input
                          type="radio"
                          name={`conflict-${entry.key}`}
                          checked={entry.strategy === 'skip'}
                          onChange={() => setStrategy(entry.key, 'skip')}
                        />
                        跳过
                      </label>
                    </div>
                  ) : nameNote ? (
                    /* r2：同名不同 ID 不是冲突——直接共存，列表靠 id 短后缀消歧。 */
                    <p className="mt-1 text-aux text-text-tertiary">
                      库中已有同名技能：不同 ID 视为不同技能，直接共存
                    </p>
                  ) : null}
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
            解析预览后由服务端导入落库，导入后作为「三方技能」，可编辑、可绑定任务。
          </p>
        ) : null}
        {failed.length > 0 ? (
          <p className="flex items-center gap-1 text-aux text-status-failed">
            <AlertCircle className="size-3.5" />
            存在失败的文件，请先移除或修正后再导入
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

function baseEntry(file: File, text: string, source: SourceKind): Pick<
  ParsedEntry,
  'key' | 'fileName' | 'source' | 'file' | 'text' | 'strategy'
> {
  return { key: nextKey(), fileName: file.name, source, file, text, strategy: 'overwrite' };
}

/** .atskill：导出载荷 {id?,name,type,content,...} 或完整技能 JSON（预览用；落库走后端）。 */
function parseAtskill(file: File, text: string): ParsedEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON 解析失败：${error instanceof Error ? error.message : '格式不合法'}`);
  }
  const payload = parsed as {
    id?: string;
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
    ...baseEntry(file, text, 'atskill'),
    // 名称优先取文件里的 `name`：导出的文件名是技能 ID（`skl_xxx.atskill`），
    // 只按文件名起名会让「导出再导入」得到一个 ID 名字的技能。
    name: payload.name?.trim() || stripExtension(file.name, '.atskill'),
    type: isSkillType(payload.type) ? payload.type : 'prompt',
    content,
    description: payload.description ?? '',
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    warnings: [],
    fileId: typeof payload.id === 'string' && payload.id.trim() ? payload.id.trim() : null,
  };
}

/** SKILL.md / .md：markdownToBlocks 前端预览解析。 */
function parseMarkdown(file: File, text: string, source: SourceKind): ParsedEntry {
  const result = markdownToBlocks(text);
  if (result.content.blocks.length === 0) {
    throw new Error('没有解析出任何内容块：正文需要「### 块标题」小节');
  }
  const name = result.frontmatter?.name?.trim() || stripExtension(file.name, '.md');
  return {
    ...baseEntry(file, text, source),
    name,
    type: source === 'cursor-rules' ? 'prompt' : guessType(result),
    content: result.content,
    description: result.frontmatter?.description?.trim() ?? '',
    tags: result.frontmatter?.tags ?? [],
    warnings: [...result.warnings],
    fileId: result.frontmatter?.id?.trim() || null,
  };
}

/** Cursor Rules .mdc：剥 Cursor frontmatter（description/globs/alwaysApply）再走同一 markdown 转换。 */
function parseCursorRules(file: File, text: string): ParsedEntry {
  let body = text;
  let description = '';
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (fm) {
    body = text.slice(fm[0].length);
    const descLine = fm[1].split('\n').find((line) => line.startsWith('description:'));
    description = descLine ? descLine.slice('description:'.length).trim() : '';
  }
  /* Cursor Rules 正文没有 ### 小节时整体作为一个提示词块预览。 */
  const normalized = body.includes('### ')
    ? body
    : ['---', `name: ${stripExtension(file.name, '.mdc')}`, `description: ${description.replace(/\n/g, ' ')}`, '---', '', `### 规则`, '', `<!-- atb:prompt -->`, '', body.trim()].join('\n');
  const parsed = parseMarkdown(file, normalized, 'cursor-rules');
  parsed.name = stripExtension(file.name, '.mdc');
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

/** 无 frontmatter 类型信息时按块形状粗略推断类型（仅预览；服务端导入按 prompt/flow 归一）。 */
function guessType(result: ReturnType<typeof markdownToBlocks>): SkillType {
  const blocks = result.content.blocks;
  if (blocks.some((block) => block.kind === 'decision' || block.kind === 'loop')) return 'flow';
  if (blocks.some((block) => block.kind === 'subskill')) return 'composite';
  if (blocks.some((block) => block.kind === 'step')) return 'steps';
  if (blocks.some((block) => block.kind === 'script')) return 'script';
  return 'prompt';
}
