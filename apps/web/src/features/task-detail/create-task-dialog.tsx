import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, fieldErrorsOf, isApiError, qk, useApiMutation, useSettings, useTaskList } from '@/api';
import { useActiveGroups } from '@/features/groups';
import type { TaskCreateInput } from '@/api';
import { Button, Dialog, Field, Input, Select, Textarea } from '@/components/ui';
import { errorMessage } from '@/api';
import { clearFieldError } from '@/lib/forms';
import { priorityText } from '@/lib/labels';

/**
 * 0919 五/六章的创建弹窗：普通任务之外支持两件事——
 * - **创建为需求**（`asRequirement`）：类型固定「需求」；需求不直接执行、不进 Agent 领取池
 *   （1.md 5.2），建完只落需求池（服务端 `create` 恒 BACKLOG）；
 * - **挂到需求**（`parentTaskId` 或表单里的「挂到需求」下拉）：`POST /tasks` 带
 *   `parent_task_id`。服务端校验：父必须是「需求」、嵌套 ≤ 2 层；违规 422，
 *   `details[].code` = `parent_type` / `too_deep`（逐字段回显在表单里）。
 *
 * 使用方：`features/task-list/create-menu.tsx`（「新建需求」入口）与需求抽屉/子任务场景。
 * 看板列底的快速新建（features/board/quick-create）不归本 feature 改。
 */

export interface TaskCreateDialogProps {
  open: boolean;
  onClose: () => void;
  /** true = 「创建为需求」：类型钉死「需求」，隐藏「挂到需求」。 */
  asRequirement?: boolean;
  /** 预选的父需求（例如从需求抽屉里发起）；仍可在下拉里改。 */
  parentTaskId?: string | null;
  /** 弹窗标题，缺省按 asRequirement 推。 */
  heading?: string;
}

export function TaskCreateDialog({ open, onClose, asRequirement = false, parentTaskId, heading }: TaskCreateDialogProps) {
  if (!open) return null;
  return (
    <TaskCreateForm
      key={`${asRequirement ? 'req' : 'task'}-${parentTaskId ?? 'none'}`}
      asRequirement={asRequirement}
      initialParent={parentTaskId ?? ''}
      heading={heading}
      onClose={onClose}
    />
  );
}

function TaskCreateForm({
  asRequirement,
  initialParent,
  heading,
  onClose,
}: {
  asRequirement: boolean;
  initialParent: string;
  heading?: string;
  onClose: () => void;
}) {
  const settings = useSettings();
  const groups = useActiveGroups();
  // 「挂到需求」的候选：非归档的需求类型任务（列表页按类型过滤；page_size 拉满一页够用）。
  const requirements = useTaskList({ type: ['需求'], archived: 'false', page: 1, page_size: 200 });

  const types = settings.data?.task_types ?? [];
  const [title, setTitle] = useState('');
  const [type, setType] = useState(asRequirement ? '需求' : (types.find((item) => item !== '需求') ?? types[0] ?? '任务'));
  const [priority, setPriority] = useState('2');
  const [parentId, setParentId] = useState(initialParent);
  const [groupId, setGroupId] = useState('');
  const [tagText, setTagText] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorText, setErrorText] = useState<string | null>(null);

  const create = useApiMutation((body: TaskCreateInput) => api.tasks.create(body), {
    invalidate: (context) => [
      qk.boardRoot,
      qk.tasksRoot,
      // 挂到需求时同步刷父任务的详情（children / aggregate 在详情 DTO 里）。
      ...(context.vars.parent_task_id ? [qk.taskRoot(context.vars.parent_task_id)] : []),
    ],
    toastOnError: false,
    onSuccess: (data) => {
      onClose();
      return data;
    },
  });

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setErrors({ title: '标题必填' });
      return;
    }
    setErrors({});
    setErrorText(null);
    const body: TaskCreateInput = {
      title: trimmed,
      type,
      priority: Number(priority) as 0 | 1 | 2 | 3,
      tags: parseTags(tagText),
    };
    if (description.trim()) body.description = description.trim();
    if (groupId) body.group_id = groupId;
    if (!asRequirement && parentId) body.parent_task_id = parentId;
    create.mutate(body, {
      onError: (error) => {
        const issues = fieldErrorsOf(error);
        if (isApiError(error) && Object.keys(issues).length > 0) {
          setErrors(issues);
          setErrorText(error.message);
          return;
        }
        setErrorText(errorMessage(error));
      },
    });
  };

  const requirementOptions = (requirements.data?.items ?? []).map((item) => ({
    value: item.id,
    label: `${item.id} ${item.title.length > 18 ? `${item.title.slice(0, 18)}…` : item.title}`,
  }));

  return (
    <Dialog
      open
      size="form"
      title={heading ?? (asRequirement ? '新建需求' : parentId ? '新建任务（挂到需求）' : '新建任务')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={() => void submit()}>
            创建
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
            placeholder={asRequirement ? '这个需求要达成什么' : '一句话说清要做什么'}
            onChange={(event) => {
              setTitle(event.target.value);
              clearFieldError(setErrors, 'title');
            }}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="类型" required error={errors.type}>
            {asRequirement ? (
              <Input value="需求" disabled aria-label="需求类型" />
            ) : (
              <Select
                value={type}
                invalid={Boolean(errors.type)}
                options={types.map((item) => ({ value: item, label: item }))}
                onChange={(event) => setType(event.target.value)}
              />
            )}
          </Field>
          <Field label="优先级" required error={errors.priority}>
            <Select
              value={priority}
              options={[0, 1, 2, 3].map((value) => ({ value: String(value), label: priorityText(value) }))}
              onChange={(event) => setPriority(event.target.value)}
            />
          </Field>
        </div>

        {asRequirement ? (
          <p className="text-aux text-text-tertiary">
            需求不直接执行、不进 Agent 领取池（1.md 5.2）；创建后到需求抽屉里拆子任务。
          </p>
        ) : (
          <Field
            label="挂到需求"
            hint="可选；只能挂到「需求」类型下，子任务下不能再挂（两层上限，1.md 5.4）"
            error={errors.parent_task_id}
          >
            <Select
              value={parentId}
              placeholder="不挂，作为独立任务"
              options={requirementOptions}
              invalid={Boolean(errors.parent_task_id)}
              onChange={(event) => {
                setParentId(event.target.value);
                clearFieldError(setErrors, 'parent_task_id');
              }}
            />
          </Field>
        )}

        <Field label="分组" hint="可选；归档分组不出现在候选里">
          <Select
            value={groupId}
            placeholder="未分配分组"
            options={(groups.data?.items ?? []).map((group) => ({
              value: group.id,
              label: `${group.icon ? `${group.icon} ` : ''}${group.name}`,
            }))}
            onChange={(event) => setGroupId(event.target.value)}
          />
        </Field>

        <Field label="标签" hint="逗号分隔，单个 ≤ 16 字、最多 10 个（20.3）" error={errors.tags}>
          <Input
            value={tagText}
            placeholder="后端, 缺陷修复"
            onChange={(event) => {
              setTagText(event.target.value);
              clearFieldError(setErrors, 'tags');
            }}
          />
        </Field>

        <Field label="描述" hint="Markdown，仅用于详情抽屉" error={errors.description}>
          <Textarea
            rows={2}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              clearFieldError(setErrors, 'description');
            }}
          />
        </Field>

        {errorText ? (
          <p className="text-aux text-status-failed" role="alert">
            {errorText}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

/** 与 quick-create 同一条 20.3 规则：去重、去空白、单 ≤16 字、最多 10 个。 */
function parseTags(text: string): string[] {
  const parts = text
    .split(/[,，\s]+/)
    .map((item) => item.trim().slice(0, 16))
    .filter(Boolean);
  return [...new Set(parts)].slice(0, 10);
}
