import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Link2, Link2Off, Plus, Trash2, X } from 'lucide-react';
import type { BreakdownDraftEdit } from '@/api/types';
import { Button, Card, Field, Input, Select, Textarea, useToast } from '@/components/ui';
import { PRIORITY_LABEL } from '@/lib/labels';
import { cn } from '@/lib/cn';
import { useSkills } from '@/features/skills/hooks';
import { toggleDependency } from './draft-edit';
import { duplicateSkillNames, skillCandidateLabel, skillOptionLabel, skillStatusOf, type AnnotatedDraft } from './skill-status';

/**
 * §7.4 草案编辑面板（W7 遗留 b3 起接服务端写端点，不再是本地暂存）。
 *
 * 覆盖 PRD 表格里的最小集：标题、描述、优先级、技能（标签删 + 选择器加/换，
 * 条款 81 的歧义/未解析重选走 onPatch({ skill_ids })）、依赖连/断、删草案、加草案；
 * 验收标准编辑与「重新生成」不在本片。父需求原文（session.requirement_text）不可编辑。
 *
 * 变更全部经 onPatch/onDelete/onAdd 上抛给 overlay 的真实 mutation（乐观更新 +
 * 失败回滚）；离散控件即时提交，标题/描述这类连续输入本地缓冲、失焦才落库，
 * 避免逐键打服务端。
 */
export interface DraftEditorProps {
  /** 当前会话草案（服务端为准，含乐观覆盖；条款 81 读侧 skills_status 标注随行）。 */
  drafts: readonly AnnotatedDraft[];
  /** 被编辑草案的 ref；null = 不渲染面板。 */
  draftRef: string | null;
  onSelect: (ref: string | null) => void;
  /** PATCH 局部更新（数组字段整体替换）。 */
  onPatch: (ref: string, patch: BreakdownDraftEdit) => void;
  /** DELETE（服务端级联清悬空依赖）。 */
  onDelete: (ref: string) => void;
  /** POST 添加新草案，ref 由 overlay 取号。 */
  onAdd: () => void;
  /** 技能 id → name（null = 技能表未加载）。 */
  skillNames: Map<string, string> | null;
}

export function DraftEditor({ drafts, draftRef, onSelect, onPatch, onDelete, onAdd, skillNames }: DraftEditorProps) {
  const toast = useToast();
  const skills = useSkills(undefined, { enabled: true });
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const draft = draftRef ? (drafts.find((item) => item.ref === draftRef) ?? null) : null;

  /* 标题/描述本地缓冲（null = 无未提交输入）；切草案即丢弃缓冲。 */
  const [titleBuffer, setTitleBuffer] = useState<string | null>(null);
  const [descBuffer, setDescBuffer] = useState<string | null>(null);
  useEffect(() => {
    setTitleBuffer(null);
    setDescBuffer(null);
  }, [draftRef]);

  /* 条款 81 真机反馈：选择器里 4 个同名「发布检查」无从分辨——全量表中重名的
   * option 一律追加「类型 · …短ID 后 6 位」；判据取全量而非过滤后的列表，
   * 避免重名兄弟被 filter 掉后剩下的选项反而看不出歧义。 */
  const skillItems = skills.data?.items ?? [];
  const duplicateNames = useMemo(() => duplicateSkillNames(skillItems), [skillItems]);
  const skillById = useMemo(() => new Map(skillItems.map((skill) => [skill.id, skill])), [skillItems]);

  const skillOptions = useMemo(
    () =>
      skillItems
        .filter((skill) => !draft?.skill_ids.includes(skill.id))
        .map((skill) => ({ value: skill.id, label: skillOptionLabel(skill, duplicateNames) })),
    [skillItems, draft, duplicateNames],
  );

  if (!draft) return null;

  const others = drafts.filter((item) => item.ref !== draft.ref);
  const commitTitle = () => {
    const next = titleBuffer?.trim();
    setTitleBuffer(null);
    if (next && next !== draft.title) onPatch(draft.ref, { title: next });
  };
  const commitDesc = () => {
    if (descBuffer === null) return;
    const next = descBuffer.trim() ? descBuffer : null;
    setDescBuffer(null);
    if ((next ?? '') !== (draft.description ?? '')) onPatch(draft.ref, { description: next });
  };

  return (
    <Card className="flex flex-col gap-3 p-3" data-testid="breakdown-draft-editor">
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-code text-text-tertiary">#{draft.ref}</span>
        <Input
          value={titleBuffer ?? draft.title}
          aria-label="草案标题"
          onChange={(event) => setTitleBuffer(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitTitle();
          }}
          data-testid="breakdown-draft-title"
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onSelect(null)}
          aria-label="收起编辑面板"
          data-testid="breakdown-draft-close"
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      <Field label="描述">
        <Textarea
          value={descBuffer ?? draft.description ?? ''}
          placeholder="补充任务描述…"
          rows={2}
          onChange={(event) => setDescBuffer(event.target.value)}
          onBlur={commitDesc}
          data-testid="breakdown-draft-desc"
        />
      </Field>

      <div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
        <Field label="优先级">
          <Select
            value={String(draft.priority)}
            options={[0, 1, 2, 3].map((p) => ({ value: String(p), label: `P${p} ${PRIORITY_LABEL[p as 0 | 1 | 2 | 3]}` }))}
            onChange={(event) => onPatch(draft.ref, { priority: Number(event.target.value) })}
            data-testid="breakdown-draft-priority"
          />
        </Field>
        <Field label="绑定技能">
          <div className="flex flex-wrap items-center gap-1">
            {draft.skill_ids.map((value) => {
              const status = skillStatusOf(draft, value);
              const known = skillNames?.get(value);
              const ambiguous = status?.state === 'ambiguous';
              return (
                <span
                  key={value}
                  className={cn(
                    'inline-flex max-w-full items-center gap-1 rounded-badge px-1.5 py-px text-badge',
                    ambiguous
                      ? 'bg-status-review-soft text-status-review'
                      : known || status?.state === 'resolved'
                        ? 'bg-primary-light text-primary'
                        : 'bg-status-review-soft text-status-review',
                  )}
                  data-testid={ambiguous ? 'breakdown-draft-skill-ambiguous' : undefined}
                >
                  <span className="truncate inline-flex items-center gap-1">
                    {ambiguous ? <AlertTriangle className="size-3 shrink-0" aria-hidden /> : null}
                    {ambiguous
                      ? `歧义技能 · ${status.name}`
                      : known ??
                        status?.name ??
                        (status?.state === 'unresolved' ? `未解析 · ${status.name}` : `未解析 · ${value}`)}
                  </span>
                  <button
                    type="button"
                    aria-label={`移除技能 ${known ?? status?.name ?? value}`}
                    className="inline-flex cursor-pointer opacity-70 hover:opacity-100"
                    onClick={() =>
                      onPatch(draft.ref, { skill_ids: draft.skill_ids.filter((item) => item !== value) })
                    }
                    data-testid="breakdown-draft-skill-remove"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                  {/* 条款 81：歧义项挂候选下拉，改选即 PATCH skill_ids 原位替换（走 b3 写通道）。 */}
                  {ambiguous ? (
                    <Select
                      aria-label={`为歧义技能 ${status.name} 改选候选`}
                      value={status.skill_id ?? value}
                      className="h-5 max-w-44 border-border/60 px-1.5 pr-6 text-badge"
                      options={status.candidates.map((id) => ({
                        value: id,
                        label: skillCandidateLabel(skillById.get(id), status.name, id),
                      }))}
                      onChange={(event) => {
                        const next = event.target.value;
                        if (next && next !== value) {
                          onPatch(draft.ref, {
                            skill_ids: draft.skill_ids.map((item) => (item === value ? next : item)),
                          });
                        }
                      }}
                      data-testid="breakdown-draft-skill-reselect"
                    />
                  ) : null}
                </span>
              );
            })}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSkillPickerOpen((open) => !open)}
              disabled={skillOptions.length === 0}
              data-testid="breakdown-draft-skill-add"
            >
              <Plus className="size-3.5" aria-hidden />
              添加技能
            </Button>
          </div>
          {skillPickerOpen ? (
            <div className="mt-1.5">
              <Select
                value=""
                placeholder={skills.isPending ? '技能加载中…' : '选择技能…'}
                options={skillOptions}
                onChange={(event) => {
                  const id = event.target.value;
                  if (id) {
                    onPatch(draft.ref, { skill_ids: [...draft.skill_ids, id] });
                  }
                  setSkillPickerOpen(false);
                }}
                data-testid="breakdown-draft-skill-select"
              />
            </div>
          ) : null}
        </Field>
      </div>

      <Field label="依赖（前置任务）">
        <div className="flex flex-wrap gap-1.5">
          {others.length === 0 ? (
            <span className="text-aux text-text-tertiary">会话内暂无其它草案可连线。</span>
          ) : (
            others.map((item) => {
              const linked = draft.depends_on.includes(item.ref);
              return (
                <button
                  key={item.ref}
                  type="button"
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-control border px-2 py-1 text-aux transition-colors',
                    linked
                      ? 'border-primary/50 bg-primary-soft text-text-primary'
                      : 'border-border bg-bg-raised text-text-secondary hover:border-border-strong',
                  )}
                  onClick={() => {
                    const result = toggleDependency(drafts, item.ref, draft.ref);
                    if (!result.ok) {
                      toast.warning(
                        result.reason === 'self' ? '不能依赖自己' : '依赖成环',
                        '该连边会让依赖闭环，服务端也会拒绝（§7.8）。',
                      );
                      return;
                    }
                    const nextDeps = result.drafts.find((d) => d.ref === draft.ref)?.depends_on;
                    if (nextDeps) onPatch(draft.ref, { depends_on: nextDeps });
                  }}
                  data-testid="breakdown-draft-dep-toggle"
                  title={linked ? '点击断开依赖' : '点击建立依赖（本草案等待它完成）'}
                >
                  {linked ? <Link2Off className="size-3" aria-hidden /> : <Link2 className="size-3" aria-hidden />}
                  #{item.ref} {item.title}
                </button>
              );
            })
          )}
        </div>
      </Field>

      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          className="text-status-failed hover:text-status-failed"
          onClick={() => {
            onDelete(draft.ref);
            onSelect(null);
          }}
          data-testid="breakdown-draft-delete"
        >
          <Trash2 className="size-3.5" aria-hidden />
          删除任务
        </Button>
        <Button variant="default" size="sm" onClick={onAdd} data-testid="breakdown-draft-add">
          <Plus className="size-3.5" aria-hidden />
          添加任务
        </Button>
      </div>
    </Card>
  );
}
