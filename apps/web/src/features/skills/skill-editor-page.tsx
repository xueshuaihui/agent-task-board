import { useEffect, useState } from 'react';
import { ArrowLeft, Save, Send } from 'lucide-react';
import { Button, Field, Input, Skeleton, Tabs, Textarea, useToast } from '@/components/ui';
import { errorMessage } from '@/api';
import { BlockEditor } from './block-editor';
import { usePatchSkill, useSkill } from './hooks';
import { SKILL_STATUS_META, emptyContent } from './meta';
import { PublishDialog } from './publish-dialog';
import { SkillFlowView } from './skill-flow-view';
import type { Skill, SkillContent } from './types';
import { cn } from '@/lib/cn';

/**
 * 技能编辑器整页（2.md 第十一章）：顶栏（返回 + 名称/版本/状态 + 保存草稿/发布）
 * + 模式 Tab（可视化 / 流程图）。内容是本地草稿态，保存走 PATCH /skills/:id，
 * 发布走发布对话框（POST /versions + PATCH status）。
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
  const [mode, setMode] = useState('visual');
  const [publishOpen, setPublishOpen] = useState(false);

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

  const patch = usePatchSkill((updated) => {
    setContent(updated.content ?? emptyContent());
    setMeta({
      name: updated.name,
      description: updated.description,
      tagsText: updated.tags.join(', '),
    });
    setDirty(false);
    toast.success('草稿已保存');
  });

  const saveDraft = () => {
    if (!skill) return;
    patch.mutate(
      {
        id: skill.id,
        body: {
          content,
          name: meta.name.trim(),
          description: meta.description.trim(),
          tags: meta.tagsText
            .split(/[,，\s]+/)
            .map((tag) => tag.trim())
            .filter(Boolean),
        },
      },
      { onError: (error) => toast.error('保存失败', errorMessage(error)) },
    );
  };

  const status = skill ? SKILL_STATUS_META[skill.status] : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" icon={<ArrowLeft className="size-4" />} onClick={onClose}>
          技能库
        </Button>
        {skill ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1 className="truncate text-section-title text-text-primary">{skill.name}</h1>
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
        ) : (
          <Skeleton className="h-6 w-64" />
        )}
        <div className="ml-auto flex items-center gap-2">
          {dirty ? <span className="text-aux text-text-tertiary">有未保存修改</span> : null}
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
          { value: 'flow', label: '流程图视图' },
        ]}
        className="self-start"
      />

      <div className="min-h-0 flex-1">
        {mode === 'visual' ? (
          <div className="mx-auto max-w-3xl">
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
            setContent(updated.content ?? emptyContent());
            setDirty(false);
            toast.success('已发布新版本', `当前版本 ${updated.current_version}`);
          }}
        />
      ) : null}
    </div>
  );
}
