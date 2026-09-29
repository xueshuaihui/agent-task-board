import { useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { TaskDetail } from '@/api';
import { errorMessage, useSettings } from '@/api';
import { Button, Drawer, ErrorCopy, Tabs, type TabItem } from '@/components/ui';
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
 * @param taskId 打开的任务 id；变 `null` 时不卸载——抽屉保持挂载并播 drawerOut 退场，
 * 过渡期间继续用末次非空 id（详情查询命中缓存则直接渲染正文，不闪骨架）。
 * @param onClose 由壳层给（`useShellStore.closeTask`）。
 */
export interface TaskDetailDrawerProps {
  taskId: string | null;
  onClose: () => void;
}

export function TaskDetailDrawer({ taskId, onClose }: TaskDetailDrawerProps) {
  // 退场动画接线（统一套路）：ref 保留末次非空 taskId + open 受控，Drawer 才能经历 true→false 过渡帧。
  const lastTaskIdRef = useRef<string | null>(null);
  if (taskId) lastTaskIdRef.current = taskId;
  const shownTaskId = taskId ?? lastTaskIdRef.current;
  // 每次真正打开（false→true）递增 key 重挂子树：Tab 回到概览，与旧的「null→整体卸载」等价。
  const wasOpenRef = useRef(false);
  const sessionRef = useRef(0);
  if (taskId && !wasOpenRef.current) sessionRef.current += 1;
  wasOpenRef.current = Boolean(taskId);
  if (!shownTaskId) return null;
  return (
    <DrawerWithOverview key={sessionRef.current} taskId={shownTaskId} open={Boolean(taskId)} onClose={onClose} />
  );
}

function DrawerWithOverview({
  taskId,
  open,
  onClose,
}: Required<TaskDetailDrawerProps> & { open: boolean }) {
  const overview = useTaskOverview(taskId);
  const detail = overview.data;

  if (overview.isPending) {
    return (
      <Drawer open={open} title={`任务 ${taskId}`} onClose={onClose}>
        <LoadingBlock lines={5} />
      </Drawer>
    );
  }
  if (!detail) {
    return (
      <Drawer open={open} title={`任务 ${taskId}`} onClose={onClose}>
        {/* 以前这里直接吐 `error.message`：认不出的错误会把内部话术「服务内部错误」糊在界面上。
            走 ErrorCopy 之后，主行是「怎么办」，引擎原文收进「详情」折叠（2026-09-29 报错细化）。 */}
        <InlineError
          text={overview.error ? <ErrorCopy error={overview.error} /> : '任务详情加载失败'}
        />
      </Drawer>
    );
  }
  return <DrawerBody key={detail.id} detail={detail} open={open} onClose={onClose} />;
}

/** 拆一层是因为 `useDrawerActions` 要拿 `detail` 建动作集，没数据之前不能挂它。 */
function DrawerBody({
  detail,
  open,
  onClose,
}: {
  detail: TaskDetail;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DrawerTab>('overview');
  const settings = useSettings();
  const commentCount = useTaskCommentCount(detail.id);
  const actions = useDrawerActions({ detail, onJumpToLogs: () => setTab('runs') });
  const maxMb = settings.data?.artifact_max_mb ?? 20;
  const reducedMotion = useReducedMotion();

  const items: TabItem[] = DRAWER_TABS.map((value) => ({
    value,
    label: tabLabel(value, commentCount),
    // 三态豁免：计数拿不到时 `countFor` 不画徽标，失败由上一行 `tabLabel(value, commentCount)` 换成标签后的「—」＋title 说明（tier-2，判据与文案见本文件末尾 `tabLabel` 注释）
    count: countFor(value, detail.run_count, commentCount.data?.total ?? 0),
  }));

  return (
    <Drawer
      open={open}
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

/** 评论计数查询的状态里标签这一格要用的那几项（结构上兼容 react-query 结果）。 */
interface CommentCountState {
  isError: boolean;
  error?: unknown;
}

/**
 * 页签标签（tier-2，2026-09-29「列表报错被渲染成空状态」）：评论计数 500 时
 * `countFor` 的「0 不画徽标」规则会把「这一轮的计数没拿到」折成「确实 0 条评论」的样子，
 * 徽标就此静默消失。这里在标签后补一枚「—」把
 * "没拿到计数"说出来（徽标位类型是 `number`，破折号只能走 ReactNode 的 `label`），
 * 原因挂在 `title` 上；「执行」的 `run_count` 来自详情 DTO 本身，没有独立查询，不需要这一层。
 */
export function tabLabel(tab: DrawerTab, comments: CommentCountState): ReactNode {
  const label = TAB_LABELS[tab];
  if (tab !== 'comments' || !comments.isError) return label;
  return (
    <span title={`评论计数加载失败：${errorMessage(comments.error)}`}>
      {label}
      <span aria-hidden className="ml-1 text-text-tertiary">
        —
      </span>
    </span>
  );
}
