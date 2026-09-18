import { useState } from 'react';
import { Network } from 'lucide-react';
import { useActiveProjects } from '@/features/projects';
import { useTaskOverview } from '@/features/task-detail/queries';
import { SubtasksSection } from '@/features/task-detail/subtasks';
import { CommentsTab } from '@/features/task-detail/tabs/comments';
import { InlineError, LoadingBlock } from '@/features/task-detail/ui-bits';
import type { TaskAggregate, TaskDetail } from '@/api';
import { Badge, Button, Drawer, Progress, StatusDot, Tabs, type TabItem } from '@/components/ui';
import { cn } from '@/lib/cn';
import { priorityText } from '@/lib/labels';
import { priorityStyle, statusStyle } from '@/lib/status-style';
import { openDependencyGraph } from './dependency-graph-modal';
import { useRequirementDrawerStore } from './requirement-store';

/**
 * 需求抽屉（2.md 6.1）：需求（type=需求）的详情视图。
 *
 * 与任务详情抽屉（features/task-detail）并列的第二个抽屉单例，壳层通过
 * `<RequirementDrawerHost />` 挂载（本目录 README），入口调
 * `useRequirementDrawerStore.getState().openRequirement(id)`：
 * - 任务详情概览里的「需求」父摘要行（7.2 面包屑）；
 * - 看板/列表卡片的需求角标（4.8，`requirement-badge.tsx`）；
 * - 需求泳道「查看需求」按钮（6.4）。
 *
 * Tab：子任务（2.md 6.2）/ 依赖图（6.3，复用 features/dependency-graph 的 Dialog 能力）/
 * 活动（评论，复用任务详情的 CommentsTab）。概览内容（描述、进度、基本信息）压在头部与
 * 子任务 Tab 顶部，不单设「概览」页——需求本身没有执行/审核维度，Tab 越少越好找。
 */

type RequirementTab = 'subtasks' | 'graph' | 'activity';

const TAB_ITEMS: readonly TabItem[] = [
  { value: 'subtasks', label: '子任务' },
  { value: 'graph', label: '依赖图' },
  { value: 'activity', label: '活动' },
];

/** 壳层挂载点：`requirementId` 非空才渲染，与任务抽屉同一生命周期约定。 */
export function RequirementDrawerHost() {
  const requirementId = useRequirementDrawerStore((state) => state.requirementId);
  const close = useRequirementDrawerStore((state) => state.closeRequirement);
  if (!requirementId) return null;
  return <RequirementDrawer requirementId={requirementId} onClose={close} />;
}

export interface RequirementDrawerProps {
  requirementId: string;
  onClose: () => void;
}

export function RequirementDrawer({ requirementId, onClose }: RequirementDrawerProps) {
  const overview = useTaskOverview(requirementId);
  const detail = overview.data;

  if (overview.isPending) {
    return (
      <Drawer open title={`需求 ${requirementId}`} onClose={onClose}>
        <LoadingBlock lines={5} />
      </Drawer>
    );
  }
  if (!detail) {
    return (
      <Drawer open title={`需求 ${requirementId}`} onClose={onClose}>
        <InlineError text={overview.error?.message ?? '需求详情加载失败'} />
      </Drawer>
    );
  }
  return <RequirementDrawerBody key={detail.id} detail={detail} onClose={onClose} />;
}

function RequirementDrawerBody({ detail, onClose }: { detail: TaskDetail; onClose: () => void }) {
  const [tab, setTab] = useState<RequirementTab>('subtasks');
  const projects = useActiveProjects();
  const project = detail.project_id
    ? (projects.data?.items ?? []).find((item) => item.id === detail.project_id)
    : undefined;

  const title = (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="font-mono text-code leading-4 text-text-tertiary" data-selectable>
        {detail.id}
      </span>
      <span className="truncate text-section-title text-text-primary">{detail.title}</span>
    </div>
  );

  return (
    <Drawer
      open
      title={title}
      onClose={onClose}
      headerExtra={
        <>
          <RequirementMetaRow detail={detail} projectName={project?.name ?? null} />
          <div className="mt-2 border-b border-border px-5 pb-0">
            <Tabs
              variant="underline"
              ariaLabel="需求详情标签页"
              className="border-b-0 px-0"
              value={tab}
              onChange={(value) => setTab(value as RequirementTab)}
              items={TAB_ITEMS.map((item) =>
                item.value === 'subtasks'
                  ? { ...item, count: detail.children?.length, }
                  : item,
              )}
            />
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-1">
          <span className="text-aux text-text-secondary">描述</span>
          <p className="whitespace-pre-wrap text-body text-text-primary">
            {detail.description || '无描述'}
          </p>
        </section>
        {detail.aggregate && detail.aggregate.total > 0 ? (
          <section className="flex flex-col gap-1.5">
            <span className="text-aux text-text-secondary">
              进度：{detail.aggregate.done}/{detail.aggregate.total} 完成
            </span>
            <Progress
              value={Math.round((detail.aggregate.done / detail.aggregate.total) * 100)}
            />
          </section>
        ) : null}

        {tab === 'subtasks' ? (
          <SubtasksSection
            taskId={detail.id}
            items={detail.children ?? []}
            aggregate={detail.aggregate ?? null}
          />
        ) : null}
        {tab === 'graph' ? <GraphTab detail={detail} /> : null}
        {tab === 'activity' ? <CommentsTab taskId={detail.id} /> : null}
      </div>
    </Drawer>
  );
}

/** 6.1 头部：需求徽标、优先级、聚合状态、项目、聚合进度条。 */
function RequirementMetaRow({
  detail,
  projectName,
}: {
  detail: TaskDetail;
  projectName: string | null;
}) {
  const priority = priorityStyle(detail.priority);
  const aggregate = detail.aggregate;
  const aggregateView = aggregate
    ? AGGREGATE_VIEW[aggregate.status] ?? AGGREGATE_VIEW.IN_PROGRESS
    : null;
  const aggregateStyle = aggregateView ? statusStyle(aggregateView.status) : null;
  const percent = aggregate && aggregate.total > 0 ? Math.round((aggregate.done / aggregate.total) * 100) : null;

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 px-5 pt-2 text-aux">
      <MetaCell label="类型">
        <Badge tone="neutral">需求</Badge>
      </MetaCell>
      <MetaCell label="优先级">
        <StatusDot className={priority.dot} />
        <span className={cn('font-medium', priority.text)}>{priorityText(detail.priority)}</span>
      </MetaCell>
      <MetaCell label="聚合状态">
        {aggregateView && aggregateStyle ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <StatusDot className={aggregateStyle.dot} />
            <span className={cn('font-medium', aggregateStyle.text)}>{aggregateView.label}</span>
          </span>
        ) : (
          <span className="text-text-tertiary">暂无子任务</span>
        )}
      </MetaCell>
      <MetaCell label="项目">
        <span className={cn('truncate', projectName ? 'text-text-primary' : 'text-text-tertiary')}>
          {projectName ?? '未分配'}
        </span>
      </MetaCell>
      {percent !== null ? (
        <MetaCell label="聚合进度" className="col-span-2">
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <Progress value={percent} className="flex-1" />
            <span className="shrink-0 font-medium tabular-nums text-text-primary">
              {aggregate?.done}/{aggregate?.total}
            </span>
          </span>
        </MetaCell>
      ) : null}
    </div>
  );
}

/** 6.3：Tab 内不开第二个抽屉——给入口卡，点按用全局 `openDependencyGraph` 弹依赖图。 */
function GraphTab({ detail }: { detail: TaskDetail }) {
  const children = detail.children ?? [];
  const graphTasks = children.map((child) => ({
    id: child.id,
    title: child.title,
    status: child.status,
    priority: child.priority,
    progress: null,
    // 让 DependencyGraphDialog 的 requirementId 过滤生效（GraphTask.requirement_id）。
    requirement_id: detail.id,
  }));

  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-bg-surface p-4">
      <p className="text-body text-text-primary">查看这 {children.length} 个子任务之间的阻塞 / 关联关系。</p>
      <p className="text-aux text-text-tertiary">
        依赖是子任务级别的（1.md 5.3：子任务独立依赖关系）；在图里点击节点打开子任务详情、点击边删除依赖。
      </p>
      <div>
        <Button
          variant="primary"
          size="sm"
          icon={<Network className="size-3.5" aria-hidden />}
          disabled={children.length === 0}
          onClick={() => openDependencyGraph(graphTasks, detail.id)}
        >
          打开依赖图
        </Button>
      </div>
      {children.length === 0 ? (
        <p className="text-aux text-text-tertiary">还没有子任务，先在「子任务」里拆分。</p>
      ) : null}
    </div>
  );
}

function MetaCell({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <span className="shrink-0 text-text-secondary">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-text-primary">{children}</span>
    </div>
  );
}

/** 聚合状态 → 展示文案与样式（与 task-detail/subtasks.tsx 同一张映射，两处都是 UI 视图，不共享以免互相牵动）。 */
const AGGREGATE_VIEW: Record<TaskAggregate['status'], { label: string; status: 'DONE' | 'BACKLOG' | 'RUNNING' }> = {
  DONE: { label: '已完成', status: 'DONE' },
  BACKLOG: { label: '未开始', status: 'BACKLOG' },
  IN_PROGRESS: { label: '进行中', status: 'RUNNING' },
};
