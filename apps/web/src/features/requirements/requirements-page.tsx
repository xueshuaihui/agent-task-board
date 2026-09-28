import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  FilePlus2,
  MoreHorizontal,
  Pencil,
  Search,
  SquareKanban,
  Trash2,
} from 'lucide-react';
import { api, errorMessage, qk, useApiMutation, useTaskList, useTaskOverview } from '@/api';
import type { TaskCreateInput, TaskListItem, TaskPatchInput } from '@/api/types';
import { navigate } from '@/app/router';
import { useFilterStore } from '@/app/store/filters';
import { cn } from '@/lib/cn';
import { priorityText } from '@/lib/labels';
import { priorityStyle, statusStyle } from '@/lib/status-style';
import { formatDateTime } from '@/lib/time';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Menu,
  Pagination,
  Progress,
  Skeleton,
  StatusDot,
  Textarea,
} from '@/components/ui';
import { REQUIREMENT_TYPE } from './use-requirement-options';
import {
  SUBTASK_TYPE,
  aggregateRequirementProgress,
  requirementProgressPercent,
  type RequirementProgress,
} from './requirement-progress';
import { useRequirementDrawerStore } from './requirement-store';

/**
 * 需求页 `#/requirements`（§19.15·88，v0.0.4 r6 · R1a 切片：**只交付组件，不接路由**）。
 *
 * 产品口径（§19.15·87/88）：UI 不再有「分组」概念——本页列 **`type=需求` 的任务**，
 * 走既有 `GET /tasks?type=需求`（分页 `page`/`page_size`、`sort=updated_at`、
 * `keyword` 同一条请求），点行打开**既有需求抽屉**（不新造第二套详情视图），
 * 「在看板中打开」写统一过滤 store 的 `requirements` 维后跳看板（**不写 `groups` 维**）。
 *
 * 完成度（§19.15·88 追加段）：列表 DTO 不带 `aggregate`/`children`，行上的
 * 「子任务完成度 x/y + 进度」由第二条既有请求 `GET /tasks?type=子任务&page_size=200`
 * 按 `card.parent.id` 前端聚合（纯函数见 `requirement-progress.ts`）；未命中的行
 * **整块不显示**，不渲染 `0/0` 或猜测值。
 *
 * 生命周期全走任务级端点（§19.15·89）：新建 `POST /tasks {type:'需求'}`（**不发
 * `group_id`/`parent_task_id`**，服务端按 §5.2 落默认分组兜底）、编辑/归档/恢复/
 * 删除走单条 PATCH 与 `/tasks/{id}/archive|restore`、`DELETE /tasks/{id}`。
 * §5.5 的「x/50」是分组配额，r6 后与需求数量无关——本页**不显示**任何配额提示。
 */

/** 需求列表每页 50（口径给定的默认档）。 */
const PAGE_SIZE = 50;
/** 子任务聚合腿一次性拉满服务端上限 200；超出部分命中不到即按「不显示」处理。 */
const SUBTASK_FETCH_SIZE = 200;
/** 20.3：`keyword` 服务端上限 120，超长前端先截。 */
const KEYWORD_MAX = 120;
/** 原型 3.8 同款：搜索框防抖 300ms。 */
const KEYWORD_DEBOUNCE_MS = 300;

/** 任务级写入的统一失效前缀（与 `features/task-detail/mutations.ts` 同一口径）。 */
function taskKeys(id: string) {
  return [qk.taskRoot(id), qk.boardRoot, qk.tasksRoot];
}

/**
 * 基座 `TaskPatchInput` 的交叉类型会吃掉「清空字段」要写的 `null`（描述可清空），
 * 本 feature 内补一层——与 `task-detail/mutations.ts` 的 `DrawerTaskPatch` 同一口径。
 */
type RequirementPatchInput = Omit<TaskPatchInput, 'description'> & {
  description?: string | null;
};

function useRequirementMutations() {
  return {
    /** 新建需求：只传 {type,title,description}——`group_id`/`parent_task_id` 都不发（§19.15·89/91）。 */
    create: useApiMutation((body: TaskCreateInput) => api.tasks.create(body), {
      invalidate: [qk.boardRoot, qk.tasksRoot],
    }),
    patch: useApiMutation(
      (vars: { id: string; body: RequirementPatchInput }) =>
        api.tasks.patch(vars.id, vars.body as TaskPatchInput),
      { invalidate: ({ vars }) => taskKeys(vars.id) },
    ),
    archive: useApiMutation((id: string) => api.tasks.archive(id), {
      invalidate: ({ vars }) => taskKeys(vars),
    }),
    restore: useApiMutation((id: string) => api.tasks.restore(id), {
      invalidate: ({ vars }) => taskKeys(vars),
    }),
    /** 删除的 409（有子任务）由对话框**内联**回显 `errorMessage`，不吞掉也不另编文案。 */
    remove: useApiMutation((id: string) => api.tasks.remove(id), {
      invalidate: [qk.taskAny, qk.boardRoot, qk.tasksRoot],
      toastOnError: false,
    }),
  };
}

export type RequirementMutations = ReturnType<typeof useRequirementMutations>;

export function RequirementsPage() {
  const mutations = useRequirementMutations();

  const [page, setPage] = useState(1);
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setKeyword(keywordInput.slice(0, KEYWORD_MAX).trim());
      setPage(1);
    }, KEYWORD_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [keywordInput]);

  /** 需求列表：全部条件走同一条 `GET /tasks`（keyword 也是它的参数，不另发请求、不做前端过滤）。 */
  const list = useTaskList({
    type: [REQUIREMENT_TYPE],
    archived: 'false',
    page,
    page_size: PAGE_SIZE,
    sort: 'updated_at',
    order: 'desc',
    ...(keyword ? { keyword } : {}),
  });
  /** 完成度聚合腿：第二条既有请求，不吃 keyword（否则命中面被搜索词裁掉、进度会假缺失）。 */
  const subtasks = useTaskList({
    type: [SUBTASK_TYPE],
    page: 1,
    page_size: SUBTASK_FETCH_SIZE,
  });

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const progressByRequirement = useMemo(
    () => aggregateRequirementProgress(items, subtasks.data?.items ?? []),
    [items, subtasks.data],
  );

  /** 表单对话框目标：'create' = 新建，对象 = 编辑；null = 关闭。 */
  const [formTarget, setFormTarget] = useState<'create' | TaskListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskListItem | null>(null);

  return (
    <div className="flex min-h-0 w-full flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-page-title text-text-primary">需求</h1>
          <p className="text-aux text-text-secondary">共 {total} 条</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative w-[280px]">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-tertiary" />
            <Input
              aria-label="搜索需求标题、描述或 ID"
              className="pl-7"
              maxLength={KEYWORD_MAX}
              value={keywordInput}
              placeholder="搜索标题、描述或 ID"
              onChange={(event) => setKeywordInput(event.target.value)}
            />
          </div>
          <Button
            variant="primary"
            icon={<FilePlus2 className="size-4" aria-hidden />}
            onClick={() => setFormTarget('create')}
            data-testid="create-requirement"
          >
            新建需求
          </Button>
        </div>
      </header>

      {list.isPending ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton lines={4} />
          <Skeleton lines={4} />
          <Skeleton lines={4} />
          <Skeleton lines={4} />
          <Skeleton lines={4} />
          <Skeleton lines={4} />
        </div>
      ) : list.isError ? (
        <div className="flex flex-col items-start gap-2 rounded-card border border-border bg-bg-surface p-4">
          <p className="text-body text-status-failed">{errorMessage(list.error)}</p>
          <Button size="sm" onClick={() => void list.refetch()}>
            重试
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex min-h-[320px] flex-1 items-center justify-center rounded-card border border-border bg-bg-surface">
          <EmptyState
            icon={<span aria-hidden className="text-2xl leading-none">📋</span>}
            title={keyword ? '没有匹配的需求' : '还没有需求'}
            description={
              keyword
                ? `没有标题、描述或 ID 命中「${keyword}」的需求`
                : '需求是子任务的父卡片：先立需求，再拆子任务交给 Agent 执行'
            }
            action={
              <Button
                variant="primary"
                icon={<FilePlus2 className="size-4" aria-hidden />}
                onClick={() => setFormTarget('create')}
              >
                新建需求
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map((task) => (
              <RequirementCard
                key={task.id}
                task={task}
                progress={progressByRequirement.get(task.id)}
                mutations={mutations}
                onEdit={() => setFormTarget(task)}
                onDelete={() => setDeleteTarget(task)}
              />
            ))}
          </div>
          {total > PAGE_SIZE ? (
            <Pagination total={total} page={page} pageSize={PAGE_SIZE} onPageChange={setPage} />
          ) : null}
        </>
      )}

      <RequirementFormDialog
        open={formTarget !== null}
        requirement={formTarget === 'create' || formTarget === null ? null : formTarget}
        onClose={() => setFormTarget(null)}
      />
      {deleteTarget ? (
        <RequirementDeleteDialog
          requirement={deleteTarget}
          mutations={mutations}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
    </div>
  );
}

function RequirementCard({
  task,
  progress,
  mutations,
  onEdit,
  onDelete,
}: {
  task: TaskListItem;
  /** 聚合命中值；`undefined` = 本页子任务请求没捞到它的任何子卡（含超 200 截断）→ 完成度整块不显示（§19.15·88）。 */
  progress: RequirementProgress | undefined;
  mutations: RequirementMutations;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const status = statusStyle(task.status);
  const priority = priorityStyle(task.priority);
  const archived = task.archived_at !== null;

  const openDrawer = () =>
    useRequirementDrawerStore.getState().openRequirement(task.id);
  /** §19.15·88：「在看板中打开」= 写 `requirements` 维后跳看板，不再写 `groups` 维。 */
  const openInBoard = (event: MouseEvent) => {
    event.stopPropagation();
    useFilterStore.getState().setDimension('requirements', [task.id]);
    navigate('board');
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`打开需求 ${task.title}`}
      onClick={openDrawer}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openDrawer();
        }
      }}
      className="flex cursor-pointer flex-col gap-2 rounded-card border border-border bg-bg-surface p-4 text-left shadow-card transition-[border-color] duration-140 ease-settle hover:border-border-strong focus-visible:outline-2 focus-visible:outline-primary"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot className={status.dot} />
          <span className="truncate text-card-title text-text-primary">{task.title}</span>
        </div>
        <RequirementMenu
          task={task}
          archived={archived}
          mutations={mutations}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Badge className={cn(priority.soft, priority.text)} icon={<StatusDot className={priority.dot} />}>
          {priorityText(task.priority)}
        </Badge>
        <Badge tone="neutral">{task.status_label}</Badge>
        {archived ? <Badge tone="neutral">已归档</Badge> : null}
      </div>

      {progress ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2 text-aux">
            <span className="text-text-secondary">子任务完成度</span>
            <span className="tabular-nums text-text-primary">
              {progress.done}/{progress.total}
            </span>
          </div>
          <Progress value={requirementProgressPercent(progress)} />
        </div>
      ) : null}

      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-aux text-text-tertiary">
          更新于 {formatDateTime(task.updated_at)}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="text-primary"
          icon={<SquareKanban className="size-3.5" aria-hidden />}
          onClick={openInBoard}
        >
          在看板中打开
        </Button>
      </div>
    </div>
  );
}

function RequirementMenu({
  task,
  archived,
  mutations,
  onEdit,
  onDelete,
}: {
  task: TaskListItem;
  archived: boolean;
  mutations: RequirementMutations;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const busy =
    (mutations.archive.isPending && mutations.archive.variables === task.id) ||
    (mutations.restore.isPending && mutations.restore.variables === task.id);

  return (
    <span onClick={(event) => event.stopPropagation()}>
      <Menu
        align="end"
        width={180}
        groups={[
          {
            items: [
              {
                id: 'edit',
                label: '编辑',
                icon: <Pencil className="size-3.5" aria-hidden />,
                onSelect: onEdit,
              },
              archived
                ? {
                    id: 'restore',
                    label: '取消归档',
                    icon: <ArchiveRestore className="size-3.5" aria-hidden />,
                    onSelect: () => mutations.restore.mutate(task.id),
                  }
                : {
                    id: 'archive',
                    label: '归档',
                    icon: <Archive className="size-3.5" aria-hidden />,
                    onSelect: () => mutations.archive.mutate(task.id),
                  },
              {
                id: 'delete',
                label: '删除',
                danger: true,
                icon: <Trash2 className="size-3.5" aria-hidden />,
                hint: '有子任务会被拒',
                onSelect: onDelete,
              },
            ],
          },
        ]}
        trigger={({ open }) => (
          <IconButton
            label={`${task.title} 的操作`}
            size="iconSm"
            aria-expanded={open}
            loading={busy}
            icon={<MoreHorizontal className="size-4" />}
          />
        )}
      />
    </span>
  );
}

/**
 * 轻量需求表单（本页自建）：标题必填、描述可选。
 * 新建提交 `POST /tasks {type:'需求', title, description}`——**不发 `group_id`、
 * 不发 `parent_task_id`**（§19.15·89，服务端 §5.2 落默认分组兜底）；
 * 编辑提交单条 PATCH。禁止复用/改动 create-task-dialog（它有另棒所有权）。
 */
function RequirementFormDialog({
  open,
  requirement,
  onClose,
}: {
  open: boolean;
  /** null = 新建。 */
  requirement: TaskListItem | null;
  onClose: () => void;
}) {
  const mutations = useRequirementMutations();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  /** 描述在列表 DTO 上不带（`TaskDetail` 才有）：编辑时从概览查询回显。 */
  const overview = useTaskOverview(open && requirement ? requirement.id : null);
  const [descDirty, setDescDirty] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(requirement?.title ?? '');
    setDescription('');
    setDescDirty(false);
  }, [open, requirement]);
  useEffect(() => {
    if (open && requirement && !descDirty && overview.data) {
      setDescription(overview.data.description ?? '');
    }
  }, [open, requirement, descDirty, overview.data]);

  const submitting = mutations.create.isPending || mutations.patch.isPending;
  const canSubmit = title.trim().length > 0;

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const desc = description.trim();
    try {
      if (requirement) {
        await mutations.patch.mutateAsync({
          id: requirement.id,
          body: { title: trimmed, description: desc === '' ? null : desc },
        });
      } else {
        await mutations.create.mutateAsync({
          title: trimmed,
          type: REQUIREMENT_TYPE,
          ...(desc === '' ? {} : { description: desc }),
        });
      }
      onClose();
    } catch {
      // 失败已由 useApiMutation 按 errorMessage(error) 弹 Toast，这里只留窗不吞文案。
    }
  };

  return (
    <Dialog
      open={open}
      size="form"
      title={requirement ? `编辑需求：${requirement.title}` : '新建需求'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!canSubmit}
            loading={submitting}
            onClick={() => void submit()}
            data-testid="requirement-form-submit"
          >
            {requirement ? '保存' : '创建需求'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="标题" required htmlFor="requirement-form-title">
          <Input
            id="requirement-form-title"
            value={title}
            maxLength={200}
            placeholder="一句话说清这个需求"
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="描述" hint="可选" htmlFor="requirement-form-description">
          <Textarea
            id="requirement-form-description"
            rows={4}
            value={description}
            placeholder="背景、验收口径、约束…"
            onChange={(event) => {
              setDescDirty(true);
              setDescription(event.target.value);
            }}
          />
        </Field>
      </div>
    </Dialog>
  );
}

/**
 * 删除确认：`DELETE /tasks/{id}`。服务端「仍有子任务」的 409 用 `errorMessage(error)`
 * 原样内联回显（§19.15·89 沿用现有文案与链路），不吞掉、不自编。
 */
function RequirementDeleteDialog({
  requirement,
  mutations,
  onClose,
}: {
  requirement: TaskListItem;
  mutations: RequirementMutations;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setError(null);
    try {
      await mutations.remove.mutateAsync(requirement.id);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <Dialog
      open
      size="form"
      title={`删除需求：${requirement.title}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="danger"
            loading={mutations.remove.isPending}
            onClick={() => void confirm()}
            data-testid="requirement-delete-confirm"
          >
            删除需求
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="flex items-start gap-2 text-body text-text-primary">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-failed" aria-hidden />
          删除后需求本身不再存在；若它还有子任务，服务端会拒绝并说明原因。
        </p>
        {error ? (
          <p className="flex items-start gap-2 rounded-card bg-status-failed-soft px-3 py-2 text-aux text-status-failed">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
