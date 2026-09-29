import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, fieldErrorsOf, isApiError, qk, useApiMutation, useSettings, useTaskList } from '@/api';
import type { TaskCreateInput } from '@/api';
import { Button, Dialog, ErrorCopy, ErrorText, Field, Input, Select, Textarea } from '@/components/ui';
import {
  ReviewModeField,
  reviewModeBody,
  type ReviewModeChoice,
} from '@/features/review/review-mode-field';
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
  // 退场动画接线（统一套路）：open 变 false 不再整体卸载——Dialog 常驻、受控传给内层，
  // 经历 true→false 过渡帧播 140ms 退场，关闭期间表单快照仍是刚才那份。
  // 每次真正打开（false→true）递增 key 重挂内层：输入回到空态（与旧的 `!open → return null` 等价）。
  const wasOpenRef = useRef(false);
  const sessionRef = useRef(0);
  if (open && !wasOpenRef.current) sessionRef.current += 1;
  wasOpenRef.current = open;
  if (!open && sessionRef.current === 0) return null; // 从未打开过：不渲染（首开不受影响）
  return (
    <TaskCreateForm
      key={`${asRequirement ? 'req' : 'task'}-${parentTaskId ?? 'none'}-s${sessionRef.current}`}
      open={open}
      asRequirement={asRequirement}
      initialParent={parentTaskId ?? ''}
      heading={heading}
      onClose={onClose}
    />
  );
}

function TaskCreateForm({
  open,
  asRequirement,
  initialParent,
  heading,
  onClose,
}: {
  open: boolean;
  asRequirement: boolean;
  initialParent: string;
  heading?: string;
  onClose: () => void;
}) {
  const settings = useSettings();
  // 「挂到需求」的候选：非归档的需求类型任务（列表页按类型过滤；page_size 拉满一页够用）。
  const requirements = useTaskList({ type: ['需求'], archived: 'false', page: 1, page_size: 200 });

  const types = settings.data?.task_types ?? [];
  const [title, setTitle] = useState('');
  const [type, setType] = useState(asRequirement ? '需求' : (types.find((item) => item !== '需求') ?? types[0] ?? '任务'));
  const [priority, setPriority] = useState('2');
  const [parentId, setParentId] = useState(initialParent);
  const [tagText, setTagText] = useState('');
  const [reviewMode, setReviewMode] = useState<ReviewModeChoice>('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** 存原始错误而不是拼好的句子：就地那行要走 `<ErrorCopy>`（细化文案 + 折叠引擎原文）。 */
  const [submitError, setSubmitError] = useState<unknown>(null);

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
    setSubmitError(null);
    const body: TaskCreateInput = {
      title: trimmed,
      type,
      priority: Number(priority) as 0 | 1 | 2 | 3,
      tags: parseTags(tagText),
    };
    if (description.trim()) body.description = description.trim();
    // §19.15·90（r6 R3-C）：「分组」下拉并掉——归属只剩「挂到需求」一条（写 parent_task_id），
    // 分组字段不再从本弹窗发出（不传时服务端按 §5.2 落「默认」分组兜底）。
    if (!asRequirement && parentId) body.parent_task_id = parentId;
    Object.assign(body, reviewModeBody(reviewMode));
    create.mutate(body, {
      onError: (error) => {
        const issues = fieldErrorsOf(error);
        // 422 的逐字段问题落到各个字段上；两条分支都只**存原始错误**，
        // 就地那行交给 `<ErrorCopy>` 现取文案（细化文案 + 折叠引擎原文），这里不再预先拼句子。
        if (isApiError(error) && Object.keys(issues).length > 0) setErrors(issues);
        setSubmitError(error);
      },
    });
  };

  const requirementOptions = (requirements.data?.items ?? []).map((item) => ({
    value: item.id,
    label: `${item.id} ${item.title.length > 18 ? `${item.title.slice(0, 18)}…` : item.title}`,
  }));

  /* tier-2（2026-09-29「列表报错被渲染成空状态」）：两个候选源都是本弹窗之外的读取，
   * 挂掉时表现都是"控件里没有可选项"——类型下拉会空到只剩一个不在词表里的默认值，
   * 「挂到需求」会只剩占位「不挂，作为独立任务」。两句都不许说成"你没有类型/没有需求"，
   * 也不拦「创建」这条主动作（不挂需求独立建任务本来就合法）。 */
  const typesNotice: ReactNode = settings.isError ? (
    <ErrorText text="任务类型词表加载失败，类型只能按默认值提交（可在设置页确认服务状态）" error={settings.error} />
  ) : null;
  const requirementNotice: ReactNode = requirements.isError ? (
    <ErrorText text="需求候选加载失败，本轮先作为独立任务创建（建完可在详情「概览」补挂）" error={requirements.error} />
  ) : null;

  return (
    <Dialog
      open={open}
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
          <Field label="类型" required error={errors.type ?? typesNotice}>
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
            error={errors.parent_task_id ?? requirementNotice}
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

        {/* 需求不执行、不进 REVIEW（1.md 5.2），审核方式对它无意义——「创建为需求」时不给这一项。 */}
        {asRequirement ? null : (
          <ReviewModeField
            value={reviewMode}
            onChange={setReviewMode}
            allowDefault
            globalDefault={settings.data?.default_review_mode}
          />
        )}

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

        {submitError ? (
          <p className="text-aux text-status-failed" role="alert">
            <ErrorCopy error={submitError} />
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
