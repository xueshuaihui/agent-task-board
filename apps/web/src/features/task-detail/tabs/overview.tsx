import { useMemo, useState } from 'react';
import { Pencil } from 'lucide-react';
import { fieldErrorsOf, useFieldDefs, useSettings, useTags } from '@/api';
import type { FieldDef, TaskDetail, TaskTab } from '@/api';
import { Badge, Button, Field, Input, Select, TagBadge, Textarea } from '@/components/ui';
import { priorityText, statusLabel } from '@/lib/labels';
import { formatDateTime } from '@/lib/time';
import { useShellStore } from '@/app/store/shell';
import {
  applicableFieldDefs,
  CapabilityEditor,
  CustomFieldControl,
  draftFromValues,
  formatFieldValue,
  isPhaseOneControl,
  TagEditor,
  toSubmitValue,
  type FieldDraft,
} from '../fields';
import { TASK_RUNNING_EDIT_HINT } from '../labels';
import { usePatchTask, type DrawerTaskPatch } from '../mutations';
import { InlineError, KeyValues, Mono, Section, StatusGlyph } from '../ui-bits';
import { MarkdownLite } from '../rich-text';

/**
 * 原型 4.4 概览标签：描述 + 基本信息 + 自定义字段 + 依赖摘要。
 *
 * PRD 8.2 的概览里还画了「执行摘要 / 产物」，但原型 4.3 的说明段把它们明确放进「执行」
 * （`artifacts.run_id NOT NULL`，产物天然属于某一次 Run），且 13 章明确
 * `GET /tasks/{id}` 不含 runs / artifacts，所以这里按 4.4 的分区做，不为概览多打一次 runs。
 *
 * 编辑走 `PATCH /tasks/:id`（13 章），只提交变化过的键（服务端对 custom_fields 是 merge 语义）。
 * `RUNNING` 状态服务端直接 409 TASK_RUNNING，所以按钮先禁用并说明原因。
 */

const PRIORITY_OPTIONS = [0, 1, 2, 3].map((value) => ({
  value: String(value),
  label: priorityText(value),
}));

interface OverviewTabProps {
  taskId: string;
  detail: TaskDetail;
  onGoToTab: (tab: TaskTab) => void;
}

export function OverviewTab({ taskId, detail, onGoToTab }: OverviewTabProps) {
  const fieldDefs = useFieldDefs();
  const settings = useSettings();
  const tags = useTags();
  const patch = usePatchTask(taskId);
  const [editing, setEditing] = useState(false);

  const defs = useMemo(
    () => applicableFieldDefs(fieldDefs.data?.items ?? [], detail.type),
    [fieldDefs.data, detail.type],
  );
  const defByKey = useMemo(() => new Map(defs.map((def) => [def.key, def])), [defs]);

  const editable = detail.status !== 'RUNNING';

  const typeOptions = useMemo(() => {
    const list = settings.data?.task_types ?? [];
    const merged = list.includes(detail.type) || list.length === 0 ? list : [...list, detail.type];
    return merged.map((item) => ({ value: item, label: item }));
  }, [settings.data, detail.type]);

  const customRows = useMemo(() => {
    const stored = detail.custom_fields ?? {};
    const rows = defs.map((def) => ({
      label: def.required ? `${def.label} *` : def.label,
      value: formatFieldValue(def, stored[def.key]),
      muted: stored[def.key] === undefined || stored[def.key] === null || stored[def.key] === '',
    }));
    // 字段定义被删/停用后，任务上的旧值仍要显示（20.2：历史值不迁移）。
    const stray = Object.entries(stored)
      .filter(([key]) => !defByKey.has(key))
      .map(([key, value]) => ({
        label: `${key}（字段已停用）`,
        value: formatFieldValue(undefined, value),
        muted: false,
      }));
    return [...rows, ...stray];
  }, [defs, defByKey, detail.custom_fields]);

  const finishSave = () => {
    setEditing(false);
    patch.reset();
  };

  return (
    <div className="flex flex-col gap-5">
      <Section title="描述" meta="编辑见「基本信息 · 编辑」表单">
        {detail.description ? <MarkdownLite text={detail.description} /> : <p className="text-body text-text-tertiary">无描述</p>}
      </Section>

      <Section
        title="基本信息"
        meta={editable ? undefined : TASK_RUNNING_EDIT_HINT}
        action={
          editable ? (
            <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditing((value) => !value)}>
              {editing ? '收起' : '编辑'}
            </Button>
          ) : null
        }
      >
        {editing ? (
          <OverviewEditForm
            detail={detail}
            defs={defs}
            typeOptions={typeOptions}
            tagCandidates={tags.data?.tags ?? []}
            onCancel={() => {
              setEditing(false);
              patch.reset();
            }}
            onSubmit={(body) => patch.mutate(body, { onSuccess: finishSave })}
            pending={patch.isPending}
            errors={patch.isError ? fieldErrorsOf(patch.error) : {}}
            errorText={patch.isError ? patch.error.message : null}
          />
        ) : (
          <KeyValues
            rows={[
              { label: '类型', value: detail.type },
              { label: '优先级', value: priorityText(detail.priority) },
              {
                label: '标签',
                value:
                  detail.tags.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {detail.tags.map((tag) => (
                        <TagBadge key={tag}>{tag}</TagBadge>
                      ))}
                    </span>
                  ) : (
                    '—'
                  ),
                muted: detail.tags.length === 0,
              },
              {
                label: '所需能力',
                value:
                  detail.required_capabilities.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {detail.required_capabilities.map((item) => (
                        <Badge key={item} tone="neutral">
                          {item}
                        </Badge>
                      ))}
                    </span>
                  ) : (
                    '未声明（任何 Agent 可领）'
                  ),
              },
              { label: '截止时间', value: detail.due_at ? formatDateTime(detail.due_at) : '—' },
              { label: '创建时间', value: formatDateTime(detail.created_at) },
              { label: '更新时间', value: formatDateTime(detail.updated_at) },
              detail.archived_at
                ? { label: '归档时间', value: formatDateTime(detail.archived_at) }
                : {
                    label: '当前执行者',
                    value: detail.agent_name ?? '—',
                    muted: !detail.agent_name,
                  },
            ]}
          />
        )}
      </Section>

      <Section title="自定义字段">
        {customRows.length === 0 ? (
          <p className="text-aux text-text-tertiary">当前任务类型没有适用的自定义字段（6.9）。</p>
        ) : (
          <KeyValues rows={customRows} />
        )}
      </Section>

      <Section
        title="依赖摘要"
        action={
          <Button size="sm" variant="ghost" onClick={() => onGoToTab('dependencies')}>
            管理依赖 →
          </Button>
        }
      >
        <KeyValues
          rows={[
            {
              label: '前置',
              value: detail.depends_on.length === 0 ? '无' : <DependencyChips refs={detail.depends_on} />,
            },
            {
              label: '后续',
              value: detail.blocks.length === 0 ? '无' : <DependencyChips refs={detail.blocks} />,
            },
          ]}
        />
      </Section>
    </div>
  );
}

function DependencyChips({ refs }: { refs: TaskDetail['depends_on'] }) {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {refs.map((ref) => (
        <button
          key={ref.dep_id}
          type="button"
          onClick={() => useShellStore.getState().openTask(ref.id)}
          className="inline-flex items-center gap-1 text-body text-text-primary hover:text-primary"
          title={`${statusLabel(ref.status)} · 打开 ${ref.id}`}
        >
          <StatusGlyph status={ref.status} />
          <Mono>{ref.id}</Mono>
          <span className="max-w-[160px] truncate">{ref.title}</span>
        </button>
      ))}
    </span>
  );
}

interface EditFormProps {
  detail: TaskDetail;
  defs: FieldDef[];
  typeOptions: { value: string; label: string }[];
  tagCandidates: string[];
  onCancel: () => void;
  onSubmit: (body: DrawerTaskPatch) => void;
  pending: boolean;
  errors: Record<string, string>;
  errorText: string | null;
}

/** 受控表单 + 「只提交变化过的键」：PATCH 是增量语义，`custom_fields` 由服务端 merge（20.10）。 */
function OverviewEditForm({
  detail,
  defs,
  typeOptions,
  tagCandidates,
  onCancel,
  onSubmit,
  pending,
  errors,
  errorText,
}: EditFormProps) {
  const [description, setDescription] = useState(detail.description ?? '');
  const [type, setType] = useState(detail.type);
  const [priority, setPriority] = useState(String(detail.priority));
  const [tagsValue, setTagsValue] = useState<string[]>(detail.tags);
  const [capabilities, setCapabilities] = useState<string[]>(detail.required_capabilities);
  const [dueAt, setDueAt] = useState(detail.due_at ?? '');
  const [custom, setCustom] = useState<FieldDraft>(() => draftFromValues(defs, detail.custom_fields ?? {}));

  const save = () => {
    const body: DrawerTaskPatch = {};
    if (description !== (detail.description ?? '')) {
      body.description = description.trim() === '' ? null : description;
    }
    if (type !== detail.type) body.type = type;
    if (priority !== String(detail.priority)) {
      body.priority = Number(priority) as 0 | 1 | 2 | 3;
    }
    if (tagsValue.join('\u0000') !== detail.tags.join('\u0000')) body.tags = tagsValue;
    if (capabilities.join('\u0000') !== detail.required_capabilities.join('\u0000')) {
      body.required_capabilities = capabilities;
    }
    if (dueAt !== (detail.due_at ?? '')) body.due_at = dueAt === '' ? null : dueAt;

    const changed: Record<string, unknown> = {};
    for (const def of defs) {
      if (!isPhaseOneControl(def.type)) continue;
      const next = toSubmitValue(def, custom[def.key] ?? '');
      const previous = detail.custom_fields?.[def.key] ?? null;
      if (JSON.stringify(next ?? null) !== JSON.stringify(previous ?? null)) changed[def.key] = next;
    }
    if (Object.keys(changed).length > 0) body.custom_fields = changed;

    if (Object.keys(body).length === 0) {
      onCancel();
      return;
    }
    onSubmit(body);
  };

  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-bg-surface p-3">
      <Field label="描述" hint="支持 Markdown 子集：标题 / 列表 / 代码块 / 链接">
        <Textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="类型" htmlFor="task-type">
          <Select id="task-type" value={type} options={typeOptions} onChange={(event) => setType(event.target.value)} />
        </Field>
        <Field label="优先级" htmlFor="task-priority">
          <Select
            id="task-priority"
            value={priority}
            options={PRIORITY_OPTIONS}
            onChange={(event) => setPriority(event.target.value)}
          />
        </Field>
      </div>
      <Field label="标签" hint="回车添加；候选来自历史标签的实时聚合（20.3）">
        <TagEditor value={tagsValue} candidates={tagCandidates} onChange={setTagsValue} />
      </Field>
      <Field label="所需能力" hint="任务的 required_capabilities ⊆ Token 能力才可被领取（20.5）">
        <CapabilityEditor value={capabilities} onChange={setCapabilities} />
      </Field>
      <Field label="截止时间">
        <Input type="date" value={dueAt.slice(0, 10)} onChange={(event) => setDueAt(event.target.value)} />
      </Field>

      {defs.length > 0 ? (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          {defs.map((def) => (
            <CustomFieldControl
              key={def.key}
              def={def}
              value={custom[def.key] ?? ''}
              onChange={(value) => setCustom((prev) => ({ ...prev, [def.key]: value }))}
              error={errors[`custom_fields.${def.key}`]}
            />
          ))}
        </div>
      ) : null}

      {errorText ? <InlineError text={errorText} /> : null}

      <div className="flex items-center justify-end gap-2">
        <Button size="sm" onClick={onCancel} disabled={pending}>
          取消
        </Button>
        <Button size="sm" variant="primary" loading={pending} onClick={save}>
          保存
        </Button>
      </div>
    </div>
  );
}
