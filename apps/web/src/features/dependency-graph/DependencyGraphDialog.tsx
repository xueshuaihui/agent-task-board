import { useMemo, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Dialog, Button, Badge, StatusDot } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { STATUS_LABEL, DEPENDENCY_TYPE_LABEL } from '@/lib/labels';
import { STATUS_STYLE } from '@/lib/status-style';
import type { DependencyType } from '@/api/types';
import { TASK_STATUSES } from '@/api/types';
import type { GraphTask, LayoutEdge } from './layout';
import { DependencyGraphCanvas } from './DependencyGraphCanvas';
import { useAddDependency, useDependencyEdges, useRemoveDependency } from './useDependencyGraph';

/**
 * 依赖图入口组件（2.md 8.1 全局依赖图 / 8.2 需求内依赖图）。
 *
 * 由调用方决定挂载点（任务详情「依赖」Tab、看板工具栏「依赖图」按钮），本组件只负责：
 * - 按需求过滤可见任务（传 `requirementId` 时按 `requirement_id` 过滤；任务 DTO 若没带
 *   该字段，调用方应自行预过滤后传入 `tasks`）；
 * - 拉取每个可见任务的依赖并并成边集（useDependencyGraph）；
 * - 增删依赖（环检测在后端，409 文案直接 Toast）；
 * - 节点点击经 `onOpenTask` 回调交还给调用方打开任务详情抽屉（接缝，不直接接线）；
 * - 边点击弹确认后删除依赖行。
 */

export interface DependencyGraphDialogProps {
  open: boolean;
  onClose: () => void;
  /** 全部（或预过滤后的）任务；布局与添加依赖下拉都用它。 */
  tasks: readonly GraphTask[];
  /** 需求内依赖图：按 requirement_id 过滤任务集合。 */
  requirementId?: string | null;
  /** 节点点击 → 打开任务详情抽屉的接缝。 */
  onOpenTask?: (taskId: string) => void;
}

export function DependencyGraphDialog({
  open,
  onClose,
  tasks,
  requirementId,
  onOpenTask,
}: DependencyGraphDialogProps) {
  const toast = useToast();

  const visibleTasks = useMemo(
    () =>
      requirementId
        ? tasks.filter((task) => ('requirement_id' in task ? task.requirement_id === requirementId : false))
        : tasks,
    [tasks, requirementId],
  );

  const { edges, loading } = useDependencyEdges(visibleTasks, open && visibleTasks.length > 0);

  /* —— 删除确认 —— */
  const [pendingEdge, setPendingEdge] = useState<LayoutEdge | null>(null);
  const removeDependency = useRemoveDependency();
  const confirmRemove = () => {
    if (!pendingEdge) return;
    const edge = pendingEdge;
    setPendingEdge(null);
    removeDependency.mutate(
      { taskId: edge.to, depId: edge.depId },
      { onSuccess: () => toast.success('依赖已删除') },
    );
  };

  /* —— 添加依赖 —— */
  const [dependsOnId, setDependsOnId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [depType, setDepType] = useState<DependencyType>('blocks');
  const addDependency = useAddDependency();
  const submitAdd = () => {
    if (!dependsOnId || !targetId || dependsOnId === targetId) return;
    addDependency.mutate(
      { taskId: targetId, dependsOn: dependsOnId, type: depType },
      {
        onSuccess: () => {
          toast.success('依赖已添加');
          setDependsOnId('');
          setTargetId('');
        },
      },
    );
  };

  const title = requirementId ? `依赖图 · ${requirementId}` : '任务依赖图';

  return (
    <Dialog open={open} onClose={onClose} title={title} size="review" className="h-[86vh]">
      <div className="flex h-full min-h-0 flex-col gap-3">
        {/* 工具栏：添加依赖 */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <TaskSelect
            value={dependsOnId}
            onChange={setDependsOnId}
            tasks={visibleTasks}
            placeholder="前置任务（被依赖）"
          />
          <span className="text-aux text-text-tertiary">→</span>
          <TaskSelect
            value={targetId}
            onChange={setTargetId}
            tasks={visibleTasks}
            placeholder="下游任务"
          />
          <select
            value={depType}
            onChange={(event) => setDepType(event.target.value as DependencyType)}
            aria-label="依赖类型"
            className="h-8 rounded-control border border-border bg-bg-surface px-2 text-aux text-text-primary"
          >
            <option value="blocks">阻塞（blocks）</option>
            <option value="relates">关联（relates）</option>
          </select>
          <Button
            variant="default"
            size="sm"
            icon={<Plus className="size-3.5" aria-hidden />}
            loading={addDependency.isPending}
            disabled={!dependsOnId || !targetId || dependsOnId === targetId}
            onClick={submitAdd}
          >
            添加依赖
          </Button>
          {loading ? (
            <span className="ml-auto inline-flex items-center gap-1 text-aux text-text-tertiary">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              正在加载依赖…
            </span>
          ) : null}
        </div>

        {/* 画布 */}
        <div className="min-h-0 flex-1">
          <DependencyGraphCanvas
            tasks={visibleTasks}
            edges={edges}
            onNodeClick={onOpenTask}
            onEdgeClick={setPendingEdge}
            className="h-full"
          />
        </div>

        {/* 图例（8.1 底栏） */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-aux text-text-secondary">
          {TASK_STATUSES.map((status) => (
            <span key={status} className="inline-flex items-center gap-1.5">
              <StatusDot className={STATUS_STYLE[status].dot} />
              {STATUS_LABEL[status]}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <svg width="28" height="8" aria-hidden>
              <line x1="0" y1="4" x2="28" y2="4" className="stroke-border-strong" strokeWidth="1.5" />
            </svg>
            阻塞依赖
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg width="28" height="8" aria-hidden>
              <line
                x1="0"
                y1="4"
                x2="28"
                y2="4"
                className="stroke-border-strong"
                strokeWidth="1.5"
                strokeDasharray="5 4"
              />
            </svg>
            关联
          </span>
          <span className="text-text-tertiary">点击节点打开详情 · 点击边删除依赖 · 滚轮缩放 / 拖拽平移</span>
        </div>
      </div>

      {/* 删除确认（8.4） */}
      <Dialog
        open={pendingEdge !== null}
        onClose={() => setPendingEdge(null)}
        title="删除依赖"
        size="form"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingEdge(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              icon={<Trash2 className="size-4" aria-hidden />}
              loading={removeDependency.isPending}
              onClick={confirmRemove}
            >
              删除
            </Button>
          </>
        }
      >
        {pendingEdge ? (
          <p className="text-body text-text-primary">
            确定删除依赖 <Badge tone="outline">{DEPENDENCY_TYPE_LABEL[pendingEdge.type]}</Badge>{' '}
            <span className="font-mono text-code">{pendingEdge.from}</span> →{' '}
            <span className="font-mono text-code">{pendingEdge.to}</span> 吗？
            {pendingEdge.type === 'blocks' ? '删除后下游任务可能立即变为可领取状态。' : null}
          </p>
        ) : null}
      </Dialog>
    </Dialog>
  );
}

function TaskSelect({
  value,
  onChange,
  tasks,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  tasks: readonly GraphTask[];
  placeholder: string;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={placeholder}
      className="h-8 max-w-56 rounded-control border border-border bg-bg-surface px-2 text-aux text-text-primary"
    >
      <option value="">{placeholder}</option>
      {tasks.map((task) => (
        <option key={task.id} value={task.id}>
          {task.id} {task.title.length > 14 ? `${task.title.slice(0, 14)}…` : task.title}
        </option>
      ))}
    </select>
  );
}
