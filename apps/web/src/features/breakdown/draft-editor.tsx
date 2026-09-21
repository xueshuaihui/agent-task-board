import { useMemo, useState } from 'react';
import { Link2, Link2Off, Plus, Trash2, X } from 'lucide-react';
import type { BreakdownDraft } from '@/api/types';
import { Button, Card, Field, Input, Select, Textarea } from '@/components/ui';
import { PRIORITY_LABEL } from '@/lib/labels';
import { cn } from '@/lib/cn';
import { useSkills } from '@/features/skills/hooks';
import { addDraft, patchDraft, removeDraft, toggleDependency } from './draft-edit';

/**
 * §7.4 草案最小编辑面板（v0.0.4 W7 遗留 b1）：待确认态下点节点/卡片展开。
 *
 * 覆盖 PRD 表格里的最小集：标题、描述、优先级、技能（标签删 + 选择器加/换）、
 * 依赖连/断、删草案、加草案；验收标准编辑与「重新生成」不在本片。
 * 父需求原文（session.requirement_text）不可编辑——面板根本不渲染其输入框。
 *
 * 所有变更经 `onChange` 上抛**本地草案数组**（api 无用户侧草案写端点，
 * 见 draft-edit.ts 头注与交接清单）。
 */
export interface DraftEditorProps {
  /** 当前会话的本地草案（含未选中项——依赖开关要全量列表）。 */
  drafts: readonly BreakdownDraft[];
  /** 被编辑草案的 ref；null = 不渲染面板。 */
  draftRef: string | null;
  onSelect: (ref: string | null) => void;
  onChange: (next: BreakdownDraft[]) => void;
  /** 技能 id → name（null = 技能表未加载）。 */
  skillNames: Map<string, string> | null;
}

export function DraftEditor({ drafts, draftRef, onSelect, onChange, skillNames }: DraftEditorProps) {
  const skills = useSkills(undefined, { enabled: true });
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const draft = draftRef ? (drafts.find((item) => item.ref === draftRef) ?? null) : null;

  const skillOptions = useMemo(() => {
    const items = skills.data?.items ?? [];
    return items
      .filter((skill) => !draft?.skill_ids.includes(skill.id))
      .map((skill) => ({ value: skill.id, label: skill.name }));
  }, [skills.data, draft]);

  if (!draft) return null;

  const others = drafts.filter((item) => item.ref !== draft.ref);

  return (
    <Card className="flex flex-col gap-3 p-3" data-testid="breakdown-draft-editor">
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-code text-text-tertiary">#{draft.ref}</span>
        <Input
          value={draft.title}
          aria-label="草案标题"
          onChange={(event) => onChange(patchDraft(drafts, draft.ref, { title: event.target.value }))}
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
          value={draft.description ?? ''}
          placeholder="补充任务描述…"
          rows={2}
          onChange={(event) => onChange(patchDraft(drafts, draft.ref, { description: event.target.value || null }))}
          data-testid="breakdown-draft-desc"
        />
      </Field>

      <div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
        <Field label="优先级">
          <Select
            value={String(draft.priority)}
            options={[0, 1, 2, 3].map((p) => ({ value: String(p), label: `P${p} ${PRIORITY_LABEL[p as 0 | 1 | 2 | 3]}` }))}
            onChange={(event) =>
              onChange(patchDraft(drafts, draft.ref, { priority: Number(event.target.value) }))
            }
            data-testid="breakdown-draft-priority"
          />
        </Field>
        <Field label="绑定技能">
          <div className="flex flex-wrap items-center gap-1">
            {draft.skill_ids.map((value) => {
              const known = skillNames?.get(value);
              return (
                <span
                  key={value}
                  className={cn(
                    'inline-flex max-w-full items-center gap-1 rounded-badge px-1.5 py-px text-badge',
                    known ? 'bg-primary-light text-primary' : 'bg-status-review-soft text-status-review',
                  )}
                >
                  <span className="truncate">{known ?? `未解析 · ${value}`}</span>
                  <button
                    type="button"
                    aria-label={`移除技能 ${known ?? value}`}
                    className="inline-flex cursor-pointer opacity-70 hover:opacity-100"
                    onClick={() =>
                      onChange(
                        patchDraft(drafts, draft.ref, {
                          skill_ids: draft.skill_ids.filter((item) => item !== value),
                        }),
                      )
                    }
                    data-testid="breakdown-draft-skill-remove"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
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
                    onChange(patchDraft(drafts, draft.ref, { skill_ids: [...draft.skill_ids, id] }));
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
                    if (result.ok) onChange(result.drafts);
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
            onChange(removeDraft(drafts, draft.ref));
            onSelect(null);
          }}
          data-testid="breakdown-draft-delete"
        >
          <Trash2 className="size-3.5" aria-hidden />
          删除任务
        </Button>
        <Button variant="default" size="sm" onClick={() => onSelect(addDraft(drafts).at(-1)?.ref ?? null)} data-testid="breakdown-draft-add">
          <Plus className="size-3.5" aria-hidden />
          添加任务
        </Button>
      </div>
    </Card>
  );
}
