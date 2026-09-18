import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { TaskCreateInput, TaskStatus, TemplatePreset } from '@/api/types';
import { errorMessage, fieldErrorsOf, isApiError, useFieldDefs, useSettings } from '@/api';
import { useActiveProjects } from '@/features/projects';
import { useGroupingStore } from './grouping/useGroupingState';
import { priorityText, STATUS_LABEL } from '@/lib/labels';
import { useToast } from '@/components/ui';
import { Button, Dialog, Field, Input, Select, Textarea } from '@/components/ui';
import type { BoardMutations } from './mutations';
import { cardDefs, CustomFieldInputs, requiredDefs, toSubmitValues, type CustomValues } from './custom-fields';

/**
 * 3.1 / 8.1 的列底快速新建：需求池与待执行两列的入口，加上已完成卡片的「新建后续任务」。
 *
 * 三条硬规则：
 * - 服务端 `create` 恒落 `BACKLOG`（20.2 默认值 + 8.1「不自动跳到待执行」），
 *   所以「建在待执行」= create → transition(READY) 两步；
 * - 必填自定义字段未填 → 服务端 422，任务留在需求池，`details[]` 按字段逐条回显（6.9.2）；
 * - 已建行的第二次提交走 PATCH + transition，不再 create 一遍（避免重复卡片）。
 *
 * 3.4 的模板只作为**预填**（类型/优先级/标签/描述/自定义字段/到期），
 * 标题仍由人写——模板若连标题一起填死，一列里会出现同名卡片。
 */
export interface QuickCreateTarget {
  target: TaskStatus;
  /** 4.3.1 规则 6：`DONE` 重做时把原任务设为新任务的前置。 */
  dependsOn?: { id: string; title: string };
  /** 3.4：模板预填值。 */
  preset?: TemplatePreset;
}

export interface QuickCreateDialogProps {
  state: QuickCreateTarget | null;
  mutations: BoardMutations;
  onClose: () => void;
}

export function QuickCreateDialog({ state, mutations, onClose }: QuickCreateDialogProps) {
  if (!state) return null;
  return (
    <QuickCreateForm
      // 每次换目标列/换前置都重挂一份，表单状态自然复位。
      key={`${state.target}-${state.dependsOn?.id ?? 'none'}`}
      state={state}
      mutations={mutations}
      onClose={onClose}
    />
  );
}

interface QuickCreateFormProps {
  state: QuickCreateTarget;
  mutations: BoardMutations;
  onClose: () => void;
}

function QuickCreateForm({ state, mutations, onClose }: QuickCreateFormProps) {
  const toast = useToast();
  const settings = useSettings();
  const fieldDefs = useFieldDefs();
  const types = settings.data?.task_types ?? ['需求'];
  const defaults = fieldDefs.data?.items ?? [];
  const preset = state.preset;

  // 6.11 的「标题前缀」也是预填值：写进输入框而不是提交时拼接，用户能看见也能改（原型 8.1）。
  const [title, setTitle] = useState(preset?.title_prefix ?? '');
  const [description, setDescription] = useState(preset?.description ?? '');
  const [type, setType] = useState(
    preset?.type && types.includes(preset.type) ? preset.type : (types[0] ?? '需求'),
  );
  const [priority, setPriority] = useState(String(preset?.priority ?? 3));
  const [tagText, setTagText] = useState((preset?.tags ?? []).join(', '));
  const [custom, setCustom] = useState<CustomValues>(preset?.custom_fields ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [createdId, setCreatedId] = useState<string | null>(null);

  // 0919 五章：创建时选归属项目。默认值取切换器「恰好只选了一个项目」的场景，
  // 其他情况留空（未分配）——项目是弱约束，不该在快速新建里替用户做主。
  const projects = useActiveProjects();
  const switcherProjectIds = useGroupingStore((state) => state.projectIds);
  const [projectId, setProjectId] = useState(
    switcherProjectIds.length === 1 ? switcherProjectIds[0] : '',
  );

  const defs = useMemo(() => defaults.filter((def) => def.enabled), [defaults]);
  const required = useMemo(() => requiredDefs(defs, type), [defs, type]);
  const optional = useMemo(() => cardDefs(defs, type), [defs, type]);
  const busy = mutations.create.isPending || mutations.advance.isPending || mutations.patch.isPending;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    setErrors({});
    const customFields = toSubmitValues([...required, ...optional], custom);

    try {
      let id = createdId;
      if (id === null) {
        const body: TaskCreateInput = {
          title: title.trim(),
          type,
          priority: Number(priority),
          custom_fields: customFields,
          tags: parseTags(tagText),
        };
        if (description.trim()) body.description = description.trim();
        if (projectId) body.project_id = projectId;
        if (preset?.required_capabilities?.length) body.required_capabilities = preset.required_capabilities;
        if (typeof preset?.due_offset_days === 'number' && preset.due_offset_days > 0) {
          body.due_at = new Date(Date.now() + preset.due_offset_days * 86_400_000).toISOString();
        }
        if (state.dependsOn) {
          body.depends_on = [state.dependsOn.id];
          body.dependency_type = 'blocks';
        }
        const created = await mutations.create.mutateAsync(body);
        id = created.id;
        setCreatedId(id);
      } else {
        // 上一轮已建行、只是必填字段没填够：补值用 PATCH，不重复创建。
        await mutations.patch.mutateAsync({ id, body: { custom_fields: customFields } });
      }

      if (state.target === 'READY') await mutations.advance.mutateAsync(id);
      toast.success(`已创建 ${id}`, `落在「${STATUS_LABEL[state.target]}」`);
      onClose();
    } catch (error) {
      handleFailure(error, toast, setErrors);
    }
  };

  return (
    <Dialog
      open
      size="form"
      title={state.dependsOn ? `新建后续任务（前置 ${state.dependsOn.id}）` : `新建任务 → ${STATUS_LABEL[state.target]}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {createdId ? '补填并继续' : state.target === 'READY' ? '创建并进待执行' : '创建'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={submit}
        onKeyDown={(event: KeyboardEvent) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit();
        }}
      >
        <Field label="标题" required error={errors.title}>
          <Input
            value={title}
            invalid={Boolean(errors.title)}
            autoFocus
            maxLength={200}
            placeholder="一句话说清要做什么"
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>

        <Field label="描述" hint="Markdown，仅用于详情抽屉" error={errors.description}>
          <Textarea
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            invalid={Boolean(errors.description)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="类型" required error={errors.type}>
            <Select
              value={type}
              invalid={Boolean(errors.type)}
              options={types.map((item) => ({ value: item, label: item }))}
              onChange={(event) => setType(event.target.value)}
            />
          </Field>
          <Field label="优先级" required error={errors.priority}>
            <Select
              value={priority}
              options={[0, 1, 2, 3].map((value) => ({ value: String(value), label: priorityText(value) }))}
              onChange={(event) => setPriority(event.target.value)}
            />
          </Field>
        </div>

        <Field label="项目" hint="可选；归档项目不出现在候选里（5.1）">
          <Select
            value={projectId}
            placeholder="未分配项目"
            options={(projects.data?.items ?? []).map((project) => ({
              value: project.id,
              label: `${project.icon ? `${project.icon} ` : ''}${project.name}`,
            }))}
            onChange={(event) => setProjectId(event.target.value)}
          />
        </Field>

        <Field label="标签" hint="逗号分隔，单个 ≤ 16 字、最多 10 个（20.3）" error={errors.tags}>
          <Input value={tagText} placeholder="后端, 缺陷修复" onChange={(event) => setTagText(event.target.value)} />
        </Field>

        {state.dependsOn ? (
          <p className="text-aux text-text-secondary">
            前置依赖：<span className="font-mono">{state.dependsOn.id}</span> {state.dependsOn.title}
            <span className="ml-1 text-text-tertiary">（blocks，5.1）</span>
          </p>
        ) : null}

        {required.length + optional.length > 0 ? (
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <p className="text-aux text-text-tertiary">自定义字段</p>
            <CustomFieldInputs
              defs={[...required, ...optional]}
              values={custom}
              errors={pickCustomErrors(errors)}
              onChange={(key, value) => setCustom((current) => ({ ...current, [key]: value }))}
            />
          </div>
        ) : null}

        {state.target === 'READY' ? (
          <p className="text-aux text-text-tertiary">
            创建后会立刻流转到「待执行」；必填字段未填时服务端会拒绝该流转，任务留在需求池。
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

/** 20.3：标签去重、去首尾空白、单个 ≤ 16 字、每任务 ≤ 10 个。 */
function parseTags(text: string): string[] {
  const parts = text
    .split(/[,，\s]+/)
    .map((item) => item.trim().slice(0, 16))
    .filter(Boolean);
  return [...new Set(parts)].slice(0, 10);
}

/** 服务端 `details[].path` 形如 `custom_fields.severity`，拆成卡片内联错误。 */
function pickCustomErrors(errors: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [path, message] of Object.entries(errors)) {
    if (!path.startsWith('custom_fields.')) continue;
    result[path.slice('custom_fields.'.length)] = message;
  }
  return result;
}

/** 只有 `VALIDATION_FAILED` 需要逐字段内联回显（6.9.2）；其余错误由 Toast 说一句话。 */
function handleFailure(
  error: unknown,
  toast: ReturnType<typeof useToast>,
  setErrors: (errors: Record<string, string>) => void,
): void {
  const issues = fieldErrorsOf(error);
  if (isApiError(error) && error.code === 'VALIDATION_FAILED') {
    setErrors(issues);
    toast.warning(error.message, Object.values(issues).slice(0, 3).join('；'));
    return;
  }
  toast.error(errorMessage(error));
}
