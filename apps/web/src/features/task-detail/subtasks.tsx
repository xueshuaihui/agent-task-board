import { useState, type FormEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Plus } from 'lucide-react';
import { api, fieldErrorsOf, isApiError, qk, useApiMutation, useSettings } from '@/api';
import type { TaskAggregate, TaskChildRef } from '@/api';
import { Badge, Button, ErrorCopy, ErrorText, Field, Input, Progress, Select, StatusDot } from '@/components/ui';
import { cn } from '@/lib/cn';
import { itemVariants, listVariants } from '@/lib/motion';
import { clearFieldError } from '@/lib/forms';
import { priorityText, statusLabel } from '@/lib/labels';
import { statusStyle } from '@/lib/status-style';
import { useShellStore } from '@/app/store/shell';
import { InlineError, Mono } from './ui-bits';

/**
 * 0919 6.2 子任务列表（2.md 第七章：需求详情里的子任务能力）。
 *
 * 同一份组件在两处使用：
 * - 任务详情抽屉概览（`tabs/overview.tsx`，任务是需求时渲染）；
 * - 需求抽屉的「子任务」标签（`features/requirements/requirement-drawer.tsx`）。
 *
 * 能力：
 * - 列表行：状态点、ID、标题、优先级；点击行 = 打开该子任务详情（复用壳层 `openTask`，
 *   详情抽屉是单实例的，点子任务即「切换详情」——现有交互里成本最低、不打架的一种）；
 * - 头部：聚合进度条 + 聚合状态徽标（后端 `aggregate.status`，1.md 5.4 状态聚合表）；
 * - 「添加子任务」内联表单：`POST /tasks` 带 `parent_task_id`，服务端校验
 *   父必须是需求、嵌套 ≤ 2 层（违规 422，`details[].code` = parent_type / too_deep）。
 */

/** 聚合状态 → 展示文案与样式（复用任务状态色 token；IN_PROGRESS 取 RUNNING 的色）。 */
const AGGREGATE_VIEW: Record<TaskAggregate['status'], { label: string; status: 'DONE' | 'BACKLOG' | 'RUNNING' }> = {
  DONE: { label: '已完成', status: 'DONE' },
  BACKLOG: { label: '未开始', status: 'BACKLOG' },
  IN_PROGRESS: { label: '进行中', status: 'RUNNING' },
};

export interface SubtasksSectionProps {
  /** 父任务（需求）id：添加子任务时作为 `parent_task_id`。 */
  taskId: string;
  /** 子任务列表（`TaskDetail.children`）。不叫 `children`：那是 React 的特殊 prop。 */
  items: readonly TaskChildRef[];
  aggregate?: TaskAggregate | null;
  className?: string;
}

export function SubtasksSection({ taskId, items, aggregate, className }: SubtasksSectionProps) {
  const [adding, setAdding] = useState(false);
  const reduce = useReducedMotion();

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="text-aux text-text-secondary">子任务</span>
          <Badge tone="outline">{items.length}</Badge>
          {aggregate ? <AggregateSummary aggregate={aggregate} /> : null}
        </div>
        <Button
          size="sm"
          variant={adding ? 'default' : 'ghost'}
          icon={<Plus className="size-3.5" />}
          onClick={() => setAdding((value) => !value)}
        >
          {adding ? '收起' : '添加子任务'}
        </Button>
      </div>

      {aggregate && aggregate.total > 0 ? (
        <Progress value={Math.round((aggregate.done / aggregate.total) * 100)} />
      ) : null}

      {adding ? <AddSubtaskForm taskId={taskId} onDone={() => setAdding(false)} /> : null}

      {items.length === 0 ? (
        <p className="text-aux text-text-tertiary">还没有子任务。需求不直接执行，拆成子任务后由 Agent 领取（1.md 5.2）。</p>
      ) : (
        // motion-spec §9-P1-8：需求抽屉/概览的子任务列表首屏 stagger（40ms、上限 240ms）+ 移除退场。
        <motion.ul
          className="flex flex-col divide-y divide-border rounded-card border border-border bg-bg-surface"
          variants={listVariants}
          initial={reduce ? false : 'hidden'}
          animate="show"
        >
          <AnimatePresence>
            {items.map((child, index) => (
              <SubtaskRow key={child.id} child={child} index={index} />
            ))}
          </AnimatePresence>
        </motion.ul>
      )}
    </div>
  );
}

/** 「1/4 完成 · 进行中」摘要行（2.md 6.1 概览的进度区）。 */
function AggregateSummary({ aggregate }: { aggregate: TaskAggregate }) {
  const view = AGGREGATE_VIEW[aggregate.status] ?? AGGREGATE_VIEW.IN_PROGRESS;
  const style = statusStyle(view.status);
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-aux text-text-secondary">
      <span className="font-medium tabular-nums text-text-primary">
        {aggregate.done}/{aggregate.total} 完成
      </span>
      <StatusDot className={style.dot} />
      <span className={cn('font-medium', style.text)}>{view.label}</span>
    </span>
  );
}

function SubtaskRow({ child, index = 0 }: { child: TaskChildRef; index?: number }) {
  const style = statusStyle(child.status === 'DONE' || child.status === 'BACKLOG' ? child.status : 'RUNNING');
  const reduce = useReducedMotion();
  return (
    <motion.li
      variants={itemVariants}
      initial={reduce ? false : 'hidden'}
      animate={reduce ? undefined : 'show'}
      custom={index}
      exit={reduce ? undefined : { opacity: 0, y: 8, transition: { duration: 0.14, ease: 'easeOut' } }}
    >
      <button
        type="button"
        onClick={() => useShellStore.getState().openTask(child.id)}
        title={`打开子任务 ${child.id}`}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-bg-muted"
      >
        <StatusDot className={style.dot} />
        <Mono className="shrink-0 text-code text-text-tertiary">{child.id}</Mono>
        <span className="min-w-0 flex-1 truncate text-body text-text-primary">{child.title}</span>
        <span className={cn('shrink-0 text-aux font-medium', style.text)}>
          {statusLabel(child.status) || '未知'}
        </span>
        <span className="shrink-0 text-aux text-text-tertiary">{priorityText(child.priority)}</span>
      </button>
    </motion.li>
  );
}

/** 内联「添加子任务」：只收标题与优先级，其余字段（描述、标签…）建完在子任务抽屉里补。 */
function AddSubtaskForm({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const settings = useSettings();
  // 子任务必须可执行：类型取词表里第一个非「需求」的类型（1.md 5.3）。
  /* tier-2（2026-09-29「列表报错被渲染成空状态」）：词表 500 时这里折成 `[]`，下面的字段会静默显示
   * 兜底值「任务」——那是替用户编一个没被词表确认过的类型（比空态更糟），必须在字段下方说一行。
   * 不拦创建：载荷仍按兜底值提交，真不合法会被服务端 422 逐字段回显（本表单已有那条错误面）。 */
  const types = settings.data?.task_types ?? [];
  const childType = types.find((type) => type !== '需求') ?? types[0] ?? '任务';
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('2');
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** 存原始错误：就地那行走 `<ErrorCopy>`，细化文案与折叠原文都由它现取。 */
  const [submitError, setSubmitError] = useState<unknown>(null);

  const create = useApiMutation((body: Parameters<typeof api.tasks.create>[0]) => api.tasks.create(body), {
    invalidate: () => [qk.taskRoot(taskId), qk.boardRoot, qk.tasksRoot],
    toastOnError: false,
    onSuccess: () => {
      setTitle('');
      setErrors({});
      setSubmitError(null);
      onDone();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setErrors({ title: '标题必填' });
      return;
    }
    setErrors({});
    setSubmitError(null);
    create.mutate(
      { title: trimmed, type: childType, priority: Number(priority) as 0 | 1 | 2 | 3, parent_task_id: taskId },
      {
        onError: (error) => {
          const issues = fieldErrorsOf(error);
          // 与新建任务弹窗同口径：422 把逐字段问题落到字段上，两条分支都只存原始错误，
          // 就地那一行交给 `<ErrorCopy>` 现取文案（细化文案 + 折叠引擎原文）。
          if (isApiError(error) && Object.keys(issues).length > 0) setErrors(issues);
          setSubmitError(error);
        },
      },
    );
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-card border border-border bg-bg-surface p-3"
      onSubmit={submit}
    >
      <Field label="子任务标题" required error={errors.title} htmlFor="add-subtask-title">
        <Input
          id="add-subtask-title"
          value={title}
          autoFocus
          maxLength={200}
          placeholder="一句话说清这个子任务"
          invalid={Boolean(errors.title)}
          onChange={(event) => {
            setTitle(event.target.value);
            clearFieldError(setErrors, 'title');
          }}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="类型"
          hint={
            settings.isError ? (
              <ErrorText text="类型词表加载失败，这里先按「任务」兜底" error={settings.error} />
            ) : (
              `子任务不可用「需求」类型（1.md 5.4）`
            )
          }
        >
          <Input value={childType} disabled aria-label="子任务类型" />
        </Field>
        <Field label="优先级" htmlFor="add-subtask-priority">
          <Select
            id="add-subtask-priority"
            value={priority}
            options={[0, 1, 2, 3].map((value) => ({ value: String(value), label: priorityText(value) }))}
            onChange={(event) => setPriority(event.target.value)}
          />
        </Field>
      </div>
      {errors.parent_task_id ? <InlineError text={errors.parent_task_id} /> : null}
      {submitError ? <InlineError text={<ErrorCopy error={submitError} />} /> : null}
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" type="button" onClick={onDone} disabled={create.isPending}>
          取消
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={create.isPending}>
          创建子任务
        </Button>
      </div>
    </form>
  );
}
