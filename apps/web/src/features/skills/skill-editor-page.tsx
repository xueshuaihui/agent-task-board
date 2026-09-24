import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Package, Save, Send } from 'lucide-react';
import { Button, Field, Input, RadioGroup, Skeleton, Tabs, Textarea, useToast } from '@/components/ui';
import { errorMessage } from '@/api';
import { BlockEditor } from './block-editor';
import { usePatchSkill, useSkill } from './hooks';
import { SKILL_CATEGORY_OPTIONS, SKILL_STATUS_META, emptyContent } from './meta';
import { toSkillCategory } from './markdown';
import { PublishDialog } from './publish-dialog';
import { SkillFlowEditor } from './flow-canvas';
import { SkillVersionHistory } from './skill-version-history';
import { SourceEditor } from './source-editor';
import { StructuredEditor } from './structured-editor';
import type { Skill, SkillCategoryOrNone, SkillContent } from './types';
import { cn } from '@/lib/cn';

/**
 * 技能编辑器整页（2.md 第十一章 + 1.md 8.3）：面包屑（技能库 / 名称）+
 * 名称/版本/状态 + 保存草稿/发布 + 模式 Tab（可视化 / 结构化 / 源码 / 流程图）。
 * 三种编辑模式共享同一份本地草稿 blocks，切换即同步；保存走 PATCH /skills/:id，
 * 发布走发布对话框（POST /versions + PATCH status）。
 *
 * 打磨点：Cmd/Ctrl+S 保存草稿；脏态关闭页面 beforeunload 拦截；脏后 3s 防抖
 * 静默自动保存，状态栏显示「已自动保存 HH:MM」。
 *
 * 接缝：由技能库页按 hash 查询参数 `?edit=<skillId>` 挂载（见 README 路由说明），
 * `onClose` 回列表；`onOpenDetail` 供外部（如任务详情技能 Tab）复用编辑器时接线。
 */

export interface SkillEditorPageProps {
  skillId: string;
  onClose: () => void;
  onOpenDetail?: (skill: Skill) => void;
}

export function SkillEditorPage({ skillId, onClose, onOpenDetail }: SkillEditorPageProps) {
  const toast = useToast();
  const query = useSkill(skillId);
  const skill = query.data;

  const [content, setContent] = useState<SkillContent>({ blocks: [], entryBlockId: null });
  const [meta, setMeta] = useState<{
    name: string;
    description: string;
    tagsText: string;
    /** 分类草稿（C-5）：初值取 skill.category；保存时始终显式提交（含 ''）。 */
    category: SkillCategoryOrNone;
  }>({
    name: '',
    description: '',
    tagsText: '',
    category: '',
  });
  const [dirty, setDirty] = useState(false);
  const [autoSavedAt, setAutoSavedAt] = useState<string | null>(null);
  const [mode, setMode] = useState('visual');
  const [publishOpen, setPublishOpen] = useState(false);
  /* 自动保存防抖定时器与「最近一次保存的快照」，避免空转请求。 */
  const autoSaveTimer = useRef<number | null>(null);

  useEffect(() => {
    if (skill) {
      setContent(skill.content ?? emptyContent());
      setMeta({
        name: skill.name,
        description: skill.description,
        tagsText: skill.tags.join(', '),
        category: skill.category,
      });
      setDirty(false);
    }
  }, [skill]);

  const applySaved = useCallback((updated: Skill) => {
    setContent(updated.content ?? emptyContent());
    setMeta({
      name: updated.name,
      description: updated.description,
      tagsText: updated.tags.join(', '),
      category: updated.category,
    });
    setDirty(false);
  }, []);

  const patch = usePatchSkill((updated) => {
    applySaved(updated);
    setAutoSavedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
  });

  const buildBody = useCallback(
    () => ({
      /* `to: ''` 是合法终态分支（「（不跳转）」），原样落库；清洗会让用户删线时连分支一起丢。 */
      content,
      name: meta.name.trim(),
      description: meta.description.trim(),
      tags: meta.tagsText
        .split(/[,，\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean),
      /* 分类始终显式提交当前值（两态语义里「传 '' = 显式改回未分类」要能表达）。 */
      category: meta.category,
    }),
    [content, meta],
  );

  const saveDraft = useCallback(() => {
    if (!skill || patch.isPending || skill.readonly) return;
    patch.mutate(
      { id: skill.id, body: buildBody() },
      { onError: (error) => toast.error('保存失败', errorMessage(error)) },
    );
  }, [skill, patch, buildBody]);

  /* 脏后 3s 防抖静默自动保存（失败只记录，不打断编辑；默认技能只读不自动保存）。 */
  useEffect(() => {
    if (!dirty || !skill || skill.readonly) return;
    if (autoSaveTimer.current != null) window.clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = window.setTimeout(() => {
      patch.mutate(
        { id: skill.id, body: buildBody() },
        { onError: (error) => toast.error('自动保存失败，可手动保存重试', errorMessage(error)) },
      );
    }, 3000);
    return () => {
      if (autoSaveTimer.current != null) window.clearTimeout(autoSaveTimer.current);
    };
  }, [dirty, skill, content, meta, patch, buildBody]);

  /* Cmd/Ctrl+S 保存草稿。 */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveDraft();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [saveDraft]);

  /* 脏态关闭页面拦截。 */
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  /* 返回列表前若还有未保存修改，先确认。 */
  const requestClose = () => {
    if (dirty && !window.confirm('有未保存的修改，确定离开？可先 Cmd/Ctrl+S 保存草稿')) return;
    onClose();
  };

  const status = skill ? SKILL_STATUS_META[skill.status] : undefined;
  /* W2 §9.1：默认技能只读——不暴露保存/发布入口，服务端 403 兜底（SKILL_READONLY）。
     W3：只读贯穿三模式与流程画布（块增删/排序/字段/源码导入全部禁用），页顶横幅说明。 */
  const readonly = skill?.readonly ?? false;

  /* 只读态兜底：任何子编辑器回调都不改草稿（正常路径下子组件已不发变更）。 */
  const applyContent = (next: SkillContent) => {
    if (readonly) return;
    setContent(next);
    setDirty(true);
  };
  const applyMeta = (patch: Partial<typeof meta>) => {
    if (readonly) return;
    setMeta((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {/* 面包屑：技能库 / {name}，可点击返回。 */}
        <div className="flex min-w-0 items-center gap-1.5 text-aux text-text-tertiary">
          <Button variant="ghost" size="sm" icon={<ArrowLeft className="size-4" />} onClick={requestClose}>
            技能库
          </Button>
          <span className="text-text-tertiary">/</span>
          {skill ? (
            <span className="max-w-[16rem] truncate text-body text-text-secondary">{skill.name}</span>
          ) : (
            <Skeleton className="h-4 w-32" />
          )}
        </div>
        {skill ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="text-aux tabular-nums text-text-tertiary">{skill.current_version}</span>
            {status ? (
              <span className={cn('rounded-badge px-2 py-0.5 text-badge', status.className)}>
                {status.label}
              </span>
            ) : null}
            {onOpenDetail ? (
              <Button variant="ghost" size="sm" onClick={() => onOpenDetail(skill)}>
                详情
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {readonly ? (
            <span className="rounded-badge bg-bg-muted px-2 py-1 text-badge text-text-secondary">
              默认技能 · 只读（随应用包更新）
            </span>
          ) : (
            <>
              {skill ? (
                <SkillVersionHistory skill={skill} draft={content} onRolledBack={applySaved} />
              ) : null}
              {dirty ? (
                <span className="text-aux text-text-tertiary">有未保存修改</span>
              ) : autoSavedAt ? (
                <span className="text-aux tabular-nums text-text-tertiary">已自动保存 {autoSavedAt}</span>
              ) : null}
              <Button
                variant="default"
                icon={<Save className="size-4" />}
                disabled={!skill || !dirty}
                loading={patch.isPending}
                onClick={saveDraft}
              >
                保存草稿
              </Button>
              <Button
                variant="primary"
                icon={<Send className="size-4" />}
                disabled={!skill || skill.status === 'ARCHIVED'}
                onClick={() => setPublishOpen(true)}
              >
                发布
              </Button>
            </>
          )}
        </div>
      </div>

      <Tabs
        variant="segmented"
        value={mode}
        onChange={setMode}
        ariaLabel="编辑模式"
        items={[
          { value: 'visual', label: '可视化模式' },
          { value: 'structured', label: '结构化模式' },
          { value: 'source', label: '源码模式' },
          { value: 'flow', label: '流程图视图' },
        ]}
        className="self-start"
      />

      {readonly ? (
        <div className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-bg-raised px-4 py-2.5 text-aux text-text-secondary">
          <Package className="size-4 shrink-0 text-text-tertiary" />
          <span>
            默认技能为只读（随应用安装包更新），三模式与流程图仅供查看。需要调整内容？到技能库用该技能的
            「复制」创建自定义技能副本后编辑。
          </span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        {mode === 'visual' ? (
          <div className="mx-auto w-full max-w-3xl">
            {skill ? (
              <div className="mb-4 flex flex-col gap-3 rounded-card border border-border bg-bg-raised p-4">
                <p className="text-card-title text-text-secondary">技能信息</p>
                <Field label="名称" htmlFor="skill-edit-name">
                  <Input
                    id="skill-edit-name"
                    value={meta.name}
                    disabled={readonly}
                    onChange={(event) => applyMeta({ name: event.target.value })}
                  />
                </Field>
                <Field
                  label="描述"
                  htmlFor="skill-edit-desc"
                  hint={meta.description.trim() ? undefined : '发布前检查要求描述不为空'}
                >
                  <Textarea
                    id="skill-edit-desc"
                    value={meta.description}
                    rows={3}
                    placeholder="这个技能解决什么问题、怎么用"
                    disabled={readonly}
                    onChange={(event) => applyMeta({ description: event.target.value })}
                  />
                </Field>
                <Field label="标签" hint="逗号或空格分隔">
                  <Input
                    value={meta.tagsText}
                    placeholder="review, quality"
                    disabled={readonly}
                    onChange={(event) => applyMeta({ tagsText: event.target.value })}
                  />
                </Field>
                <Field label="分类" hint="单选，11 类 + 未分类（PRD §9.2 系统词表）">
                  <RadioGroup
                    value={meta.category}
                    options={SKILL_CATEGORY_OPTIONS}
                    disabled={readonly}
                    onChange={(value) => applyMeta({ category: value as SkillCategoryOrNone })}
                  />
                </Field>
              </div>
            ) : null}
            {skill ? (
              <BlockEditor content={content} readOnly={readonly} onChange={applyContent} />
            ) : (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            )}
          </div>
        ) : mode === 'structured' ? (
          <div className="mx-auto w-full max-w-4xl">
            <StructuredEditor content={content} readOnly={readonly} onChange={applyContent} />
          </div>
        ) : mode === 'source' ? (
          skill ? (
            <SourceEditor
              readOnly={readonly}
              content={content}
              frontmatter={{
                name: meta.name,
                description: meta.description,
                version: skill.current_version,
                category: meta.category,
                tags: meta.tagsText
                  .split(/[,，\s]+/)
                  .map((tag) => tag.trim())
                  .filter(Boolean),
                mcpDependencies: skill.mcp_dependencies,
              }}
              onImport={(nextContent, frontmatter) => {
                if (readonly) return;
                setContent(nextContent);
                setMeta((prev) => ({
                  ...prev,
                  name: frontmatter.name || prev.name,
                  description: frontmatter.description || prev.description,
                  tagsText: frontmatter.tags.length > 0 ? frontmatter.tags.join(', ') : prev.tagsText,
                  // 分类随 frontmatter 落地：词表外值（含旧包 category=workflow 这类
                  // 类型枚举值）归未分类 ''、不报错（与 api 导入口径一致）。
                  category: toSkillCategory(frontmatter.category),
                }));
                setDirty(true);
              }}
            />
          ) : (
            <Skeleton className="h-64 w-full" />
          )
        ) : (
          <SkillFlowEditor
            content={content}
            readOnly={readonly}
            onChange={applyContent}
            className="h-[65vh]"
          />
        )}
      </div>

      {skill ? (
        <PublishDialog
          open={publishOpen}
          skill={skill}
          content={content}
          onClose={() => setPublishOpen(false)}
          onPublished={(updated) => {
            applySaved(updated);
            toast.success('已发布新版本', `当前版本 ${updated.current_version}`);
          }}
        />
      ) : null}
    </div>
  );
}
