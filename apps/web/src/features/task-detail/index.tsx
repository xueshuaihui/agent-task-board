import { useState } from 'react';
import type { TaskDetail, TaskTab } from '@/api';
import { useSettings } from '@/api';
import { Button, Drawer, Tabs, type TabItem } from '@/components/ui';
import { pickAction, type TaskAction } from './actions';
import { DrawerMetaRow, DrawerTabRow, DrawerTitle } from './drawer-header';
import { DRAWER_TABS, TAB_LABELS, TABS_WITH_COUNT } from './labels';
import { useTaskCommentCount, useTaskOverview } from './queries';
import { AuditTab } from './tabs/audit';
import { CommentsTab } from './tabs/comments';
import { DependenciesTab } from './tabs/dependencies';
import { OverviewTab } from './tabs/overview';
import { ReviewsTab } from './tabs/reviews';
import { RunsTab } from './tabs/runs';
import { useDrawerActions, type DrawerActionsApi } from './use-drawer-actions';
import { InlineError, LoadingBlock } from './ui-bits';

/**
 * 任务详情抽屉（原型 4.1 \~4.9）：容器由壳层挂（`src/app/overlay-slot.tsx`），
 * 这里只做「概览 + Tab 条 + 底部操作栏」的组合，各 Tab 的内容在 ./tabs/*。
 *
 * @param taskId 打开的任务 id；`null` 时返回 `null`——不渲染、也不留挂着的查询。
 * @param onClose 由壳层给（`useShellStore.closeTask`）。
 */
export interface TaskDetailDrawerProps {
  taskId: string | null;
  onClose: () => void;
}

export function TaskDetailDrawer({ taskId, onClose }: TaskDetailDrawerProps) {
  if (!taskId) return null;
  return <DrawerWithOverview taskId={taskId} onClose={onClose} />;
}

function DrawerWithOverview({ taskId, onClose }: Required<TaskDetailDrawerProps>) {
  const overview = useTaskOverview(taskId);
  const detail = overview.data;

  if (overview.isPending) {
    return (
      <Drawer open title={`任务 ${taskId}`} onClose={onClose}>
        <LoadingBlock lines={5} />
      </Drawer>
    );
  }
  if (!detail) {
    return (
      <Drawer open title={`任务 ${taskId}`} onClose={onClose}>
        <InlineError text={overview.error?.message ?? '任务详情加载失败'} />
      </Drawer>
    );
  }
  return <DrawerBody key={detail.id} detail={detail} onClose={onClose} />;
}

/** 拆一层是因为 `useDrawerActions` 要拿 `detail` 建动作集，没数据之前不能挂它。 */
function DrawerBody({ detail, onClose }: { detail: TaskDetail; onClose: () => void }) {
  const [tab, setTab] = useState<TaskTab>('overview');
  const settings = useSettings();
  const commentCount = useTaskCommentCount(detail.id);
  const actions = useDrawerActions({ detail, onJumpToLogs: () => setTab('runs') });
  const maxMb = settings.data?.artifact_max_mb ?? 20;

  const items: TabItem[] = DRAWER_TABS.map((value) => {
    const count = countFor(value, detail.run_count, commentCount.data?.total ?? 0);
    return { value, label: TAB_LABELS[value], count };
  });

  return (
    <Drawer
      open
      title={<DrawerTitle detail={detail} />}
      onClose={onClose}
      headerExtra={
        <>
          <DrawerMetaRow detail={detail} />
          <DrawerTabRow
            detail={detail}
            actions={actions}
            tabs={
              <Tabs
                variant="underline"
                ariaLabel="任务详情标签页"
                className="border-b-0 px-0"
                value={tab}
                onChange={(value) => setTab(value as TaskTab)}
                items={items}
              />
            }
          />
        </>
      }
      footer={<FooterBar actions={actions} />}
    >
      {tab === 'overview' ? <OverviewTab taskId={detail.id} detail={detail} onGoToTab={setTab} /> : null}
      {tab === 'runs' ? <RunsTab taskId={detail.id} detail={detail} maxMb={maxMb} /> : null}
      {tab === 'reviews' ? <ReviewsTab taskId={detail.id} /> : null}
      {tab === 'dependencies' ? <DependenciesTab taskId={detail.id} /> : null}
      {tab === 'comments' ? <CommentsTab taskId={detail.id} /> : null}
      {tab === 'audit' ? <AuditTab taskId={detail.id} /> : null}
      {actions.confirmNode}
    </Drawer>
  );
}

/** 4.9：底部只放 primary 与 secondary，`menu` 槽的动作留给头部 `⋯`。 */
function FooterBar({ actions }: { actions: DrawerActionsApi }) {
  const primary = pickAction(actions.actions, 'primary');
  const secondary = pickAction(actions.actions, 'secondary');
  if (primary.length + secondary.length === 0) return undefined;

  const button = (action: TaskAction) => (
    <Button
      key={action.id}
      size="sm"
      variant={
        action.slot === 'primary' ? (action.danger ? 'danger' : 'primary') : action.danger ? 'outlineDanger' : 'default'
      }
      loading={actions.busyId === action.id}
      title={action.hint}
      onClick={() => actions.run(action)}
    >
      {action.label}
    </Button>
  );

  return (
    <>
      {secondary.map(button)}
      {primary.map(button)}
    </>
  );
}

function countFor(tab: TaskTab, runs: number, comments: number): number | undefined {
  if (!TABS_WITH_COUNT.includes(tab)) return undefined;
  const value = tab === 'runs' ? runs : comments;
  return value > 0 ? value : undefined;
}
