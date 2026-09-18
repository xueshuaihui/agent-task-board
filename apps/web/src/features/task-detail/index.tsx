import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { TaskDetail } from '@/api';
import { useSettings } from '@/api';
import { Button, Drawer, Tabs, type TabItem } from '@/components/ui';
import { transitions } from '@/lib/motion';
import { pickAction, type TaskAction } from './actions';
import { DrawerMetaRow, DrawerTabRow, DrawerTitle } from './drawer-header';
import { DRAWER_TABS, TAB_LABELS, TABS_WITH_COUNT, type DrawerTab } from './labels';
import { useTaskCommentCount, useTaskOverview } from './queries';
import { AuditTab } from './tabs/audit';
import { CommentsTab } from './tabs/comments';
import { DependenciesTab } from './tabs/dependencies';
import { OverviewTab } from './tabs/overview';
import { ReviewsTab } from './tabs/reviews';
import { RunsTab } from './tabs/runs';
import { SkillsTab } from './tabs/skills';
import type { TaskDetailView } from './types';
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
  const [tab, setTab] = useState<DrawerTab>('overview');
  const settings = useSettings();
  const commentCount = useTaskCommentCount(detail.id);
  const actions = useDrawerActions({ detail, onJumpToLogs: () => setTab('runs') });
  const maxMb = settings.data?.artifact_max_mb ?? 20;
  const reducedMotion = useReducedMotion();

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
                onChange={(value) => setTab(value as DrawerTab)}
                items={items}
              />
            }
          />
        </>
      }
      footer={<FooterBar actions={actions} />}
    >
      {/* Tab 内容切换淡入（DESIGN §4 任务详情）：key = 活动页签，fade/rise；reduced-motion 只淡入。 */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: transitions.fade }}
          transition={reducedMotion ? transitions.fade : transitions.rise}
          className="min-w-0"
        >
          {tab === 'overview' ? <OverviewTab taskId={detail.id} detail={detail} onGoToTab={setTab} /> : null}
          {tab === 'runs' ? <RunsTab taskId={detail.id} detail={detail} maxMb={maxMb} /> : null}
          {tab === 'reviews' ? <ReviewsTab taskId={detail.id} /> : null}
          {tab === 'dependencies' ? <DependenciesTab taskId={detail.id} /> : null}
          {tab === 'comments' ? <CommentsTab taskId={detail.id} /> : null}
          {tab === 'audit' ? <AuditTab taskId={detail.id} /> : null}
          {/* 0919 10.2：skills 是后端 TaskDetailDto 额外下发、基座 TaskDetail 类型未收的字段，
              读取视图在 ./types.ts 的 TaskDetailView 补形状（不改 src/api）。 */}
          {tab === 'skills' ? <SkillsTab detail={detail as TaskDetailView} /> : null}
        </motion.div>
      </AnimatePresence>
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

function countFor(tab: DrawerTab, runs: number, comments: number): number | undefined {
  if (!TABS_WITH_COUNT.includes(tab)) return undefined;
  const value = tab === 'runs' ? runs : comments;
  return value > 0 ? value : undefined;
}
