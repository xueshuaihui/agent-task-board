import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Save, Send } from 'lucide-react';
import { Button, Field, Input, Skeleton, Tabs, Textarea, useToast } from '@/components/ui';
import { errorMessage } from '@/api';
import { BlockEditor } from './block-editor';
import { usePatchSkill, useSkill } from './hooks';
import { SKILL_STATUS_META, emptyContent } from './meta';
import { PublishDialog } from './publish-dialog';
import { SkillFlowView } from './skill-flow-view';
import { SourceEditor } from './source-editor';
import { StructuredEditor } from './structured-editor';
import type { Skill, SkillContent } from './types';
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
  const [meta, setMeta] = useState<{ name: string; description: string; tagsText: string }>({
    name: '',
    description: '',
    tagsText: '',
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
    });
    setDirty(false);
  }, []);

  const patch = usePatchSkill((updated) => {
    applySaved(updated);
    setAutoSavedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
  });

  const buildBody = useCallback(
    () => ({
      content,
      name: meta.name.trim(),
      description: meta.description.trim(),
      tags: meta.tagsText
        .split(/[,，\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    }),
    [content, meta],
  );

  const saveDraft = useCallback(() => {
    if (!skill || patch.isPending) return;
    patch.mutate(
      { id: skill.id, body: buildBody() },
      { onError: (error) => toast.error('保存失败', errorMessage(error)) },
    );
  }, [skill, patch, buildBody]);

  /* 脏后 3s 防抖静默自动保存（失败只记录，不打断编辑）。 */
  useEffect(() => {
    if (!dirty || !skill) return;
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
                    onChange={(event) => {
                      setMeta((prev) => ({ ...prev, name: event.target.value }));
                      setDirty(true);
                    }}
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
                    onChange={(event) => {
                      setMeta((prev) => ({ ...prev, description: event.target.value }));
                      setDirty(true);
                    }}
                  />
                </Field>
                <Field label="标签" hint="逗号或空格分隔">
                  <Input
                    value={meta.tagsText}
                    placeholder="review, quality"
                    onChange={(event) => {
                      setMeta((prev) => ({ ...prev, tagsText: event.target.value }));
                      setDirty(true);
                    }}
                  />
                </Field>
              </div>
            ) : null}
            {skill ? (
              <BlockEditor
                content={content}
                onChange={(next) => {
                  setContent(next);
                  setDirty(true);
                }}
              />
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
            <StructuredEditor
              content={content}
              onChange={(next) => {
                setContent(next);
                setDirty(true);
              }}
            />
          </div>
        ) : mode === 'source' ? (
          skill ? (
            <SourceEditor
              content={content}
              frontmatter={{
                name: meta.name,
                description: meta.description,
                version: skill.current_version,
                category: skill.type,
                tags: meta.tagsText
                  .split(/[,，\s]+/)
                  .map((tag) => tag.trim())
                  .filter(Boolean),
                mcpDependencies: skill.mcp_dependencies,
              }}
              onImport={(nextContent, frontmatter) => {
                setContent(nextContent);
                setMeta((prev) => ({
                  ...prev,
                  name: frontmatter.name || prev.name,
                  description: frontmatter.description || prev.description,
                  tagsText: frontmatter.tags.length > 0 ? frontmatter.tags.join(', ') : prev.tagsText,
                }));
                setDirty(true);
              }}
            />
          ) : (
            <Skeleton className="h-64 w-full" />
          )
        ) : (
          <SkillFlowView content={content} className="h-[60vh]" />
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
