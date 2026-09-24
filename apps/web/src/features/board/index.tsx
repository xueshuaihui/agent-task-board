import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { CloudOff, Plus, RotateCcw } from 'lucide-react';
import { LayoutGroup, motion } from 'motion/react';
import type { BoardColumn, TaskCard, TaskStatus } from '@/api/types';
import { errorMessage, useFieldDefs } from '@/api';
import { navigate } from '@/app/router';
import { toBoardQuery, useFilterStore } from '@/app/store/filters';
import { useShellStore, type ReviewPrefill } from '@/app/store/shell';
import { Button, EmptyState, useToast, type ToastApi } from '@/components/ui';
import { useBoardWithGroups } from '@/features/groups';
import { BoardColumnView } from './board-column';
import type { CardActions } from './card-actions';
import { DeleteDialog, StopDialog } from './dialogs';
import { FLY_BATCH_LIMIT, FLY_BATCH_SUPPRESS_MS, FLY_DROP_SUPPRESS_MS, markPendingMove, suppressFly } from './fly-motion';
import { dropStates, dropVerdict } from './matrix';
import { COLUMN_ORDER, isDefaultBoardView } from './model';
import { useBoardMutations, type BoardMutations } from './mutations';
import { QuickCreateDialog, type QuickCreateTarget } from './quick-create';
import { FlowBoardView } from './flow/FlowBoardView';
import './filter-prefs';
import { useBoardFilterUrlSync } from './filter-url-sync';
import { useViewPrefsStore } from './flow/view-prefs';
import { useDependencyEdges } from '../dependency-graph/useDependencyGraph';
import { BoardToolbar } from './toolbar';
import { FilterChipsBar } from './filter/FilterChipsBar';
import { BoardCardView } from './task-card-view';
import { useRunOverlay } from './use-run-overlay';

/**
 * 看板页（原型 3.1–3.7）。唯一数据源是 `GET /board`（20.7 的六列快照），本页不发
 * 逐列的 list 请求，也不渲染抽屉/审核表单（宿主在 `app/overlay-slot.tsx`）。
 *
 * 落点判定只有一个入口：`actions.move()` 内部跑 4.5 矩阵（`matrix.ts`）——拖拽松手、
 * 卡片菜单、键盘 `←/→`、异常卡片上的行内动作全部走它，所以非法落点**不发请求**，
 * 服务端的 `409 ILLEGAL_TRANSITION` 只剩兜底作用。
 */
export function BoardPage() {
  const toast = useToast();
  // B15-②c：过滤态 ↔ #/board?... 双向同步（URL 优先于设备偏好，之后 store 回写 URL）。
  useBoardFilterUrlSync();
  // 整份筛选状态进依赖：`toBoardQuery` 每次调用都新建对象，不 memo 就等于每次渲染
  // 换一次 query key（每帧重取 `/board`）。
  const filters = useFilterStore();
  const params = useMemo(() => toBoardQuery(filters), [filters]);
  const defaultView = useMemo(() => isDefaultBoardView(filters), [filters]);

  // B15：分组与其余过滤维度同走 `toBoardQuery` 的服务端参数，单一一份 `/board` 请求。
  const board = useBoardWithGroups(params);
  const fieldDefs = useFieldDefs();
  const defs = useMemo(() => fieldDefs.data?.items ?? [], [fieldDefs.data?.items]);
  const mutations = useBoardMutations();
  const { overlayOf } = useRunOverlay();

  const columns = useMemo(() => mergeColumns(board.data?.columns), [board.data?.columns]);

  /* --------------------------------------------- §5.2 回落规则 4：批量流转抑制 */

  /**
   * §5.2 回落规则 4：一轮数据重算里换列 ≥4 张（批量流转/导入/WS 重连全量刷）一律瞬时。
   * 对每份快照做 card→status 差分，命中即把本轮移动卡全部写进抑制名单——父组件先渲染，
   * 子列在同一次提交里读到的就是抑制后的判定；换列只来自快照重取（无本地乐观更新），
   * 所以「一次重算」与「一次 `columns` 变化」一一对应，差分放在 memo 里即是渲染帧粒度。
   */
  const prevCardStatus = useRef(new Map<string, string>());
  useMemo(() => {
    const next = new Map<string, string>();
    for (const column of columns) for (const card of column.tasks) next.set(card.id, card.status);
    const movers: string[] = [];
    for (const [id, status] of prevCardStatus.current) {
      const now = next.get(id);
      if (now !== undefined && now !== status) movers.push(id);
    }
    if (movers.length >= FLY_BATCH_LIMIT) for (const id of movers) suppressFly(id, FLY_BATCH_SUPPRESS_MS);
    prevCardStatus.current = next;
  }, [columns]);
  const cards = useMemo(() => {
    const map = new Map<string, TaskCard>();
    for (const column of columns) for (const card of column.tasks) map.set(card.id, card);
    return map;
  }, [columns]);
  const total = columns.reduce((sum, column) => sum + column.tasks.length, 0);
  /** B15-③：过滤全部走服务端（`toBoardQuery`），这里的拉平快照供依赖图与筛选弹层派生候选。 */
  const graphTasks = useMemo(() => columns.flatMap((column) => column.tasks), [columns]);

  /* -------------------------------------------- v0.0.4 W5 流程图第三视图（§6.4.1） */

  // 显示模式记忆在 prefs `board.view`（§6.4.9「视图选择记忆到用户偏好」）。
  const displayMode = useViewPrefsStore((state) => state.mode);
  // 依赖边只在流程图打开时才逐任务拉取；与详情抽屉「依赖」Tab 共享缓存。
  const dependencyEdges = useDependencyEdges(graphTasks, displayMode === 'flow');

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const [quick, setQuick] = useState<QuickCreateTarget | null>(null);
  const [stopTarget, setStopTarget] = useState<TaskCard | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskCard | null>(null);

  const actions = useCardActions(toast, mutations, setStopTarget, setDeleteTarget, setQuick);

  // 拖拽开始时按源卡片状态一次性算出六列的可放置态（PRD 7.2 首条：不在每次 hover 重算）。
  const activeCard = activeId ? cards.get(activeId) : undefined;
  const dropMap = useMemo(() => (activeCard ? dropStates(activeCard.status) : null), [activeCard]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    setOverColumn(null);
  }, []);

  const onDragOver = useCallback((event: DragOverEvent) => {
    setOverColumn(event.over ? String(event.over.id) : null);
  }, []);

  const clearDrag = useCallback(() => {
    setActiveId(null);
    setOverColumn(null);
  }, []);

  const closeQuick = useCallback(() => setQuick(null), []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const id = String(event.active.id);
      const to = columnStatusOf(event.over ? String(event.over.id) : null);
      // §5.2 回落规则 5：刚释放的拖拽源。dropAnimation（160ms）此刻已在播，
      // 写抑制名单让 `actions.move` 里的飞行标记（markPendingMove）直接跳过——
      // 拖拽换位一律以落位动画为唯一语言，快照落地后按方案 B（旧列淡出 + 新列淡入）演化。
      suppressFly(id, FLY_DROP_SUPPRESS_MS);
      clearDrag();
      if (!to) return; // 落在列外（工具栏、列间距）＝取消
      const card = cards.get(id);
      if (card) actions.move(card, to);
    },
    [actions, cards, clearDrag],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BoardToolbar
        onCreate={(template) => setQuick({ target: 'BACKLOG', preset: template?.preset })}
        graphTasks={graphTasks}
      />
      {/* B15-③：已激活条件汇总条（Linear 式），空条件时不占位。 */}
      <FilterChipsBar cards={graphTasks} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {board.isError ? (
            <EmptyState
              className="mt-6"
              icon={<CloudOff className="size-7" aria-hidden />}
              title="看板读取失败"
              description={errorMessage(board.error)}
              action={
                <Button variant="primary" icon={<RotateCcw className="size-4" />} onClick={() => void board.refetch()}>
                  重试
                </Button>
              }
            />
          ) : board.isPending ? (
            <ColumnRow>
              {COLUMN_ORDER.map((status) => (
                <BoardColumnView
                  key={status}
                  column={emptyColumn(status)}
                  defs={defs}
                  actions={actions}
                  overlayOf={overlayOf}
                  dropState={null}
                  isOver={false}
                  loading
                  onDraggingChange={ignoreDragging}
                />
              ))}
            </ColumnRow>
          ) : displayMode === 'flow' ? (
            // §6.4.1 第三视图：整页画布替换六列区，工具栏与筛选共用同一份服务端过滤后的快照。
            <FlowBoardView
              tasks={graphTasks}
              edges={dependencyEdges.edges}
              edgesLoading={dependencyEdges.loading}
              mutations={mutations}
              onRequestDelete={setDeleteTarget}
            />
          ) : total === 0 && defaultView ? (
            // 3.6 + G-5：只有「整张看板空 **且未筛**」才替掉七列；筛到 0 条时列区照常在，
            // 七列恒等分、空列各显示「暂无任务」（列不随筛选折叠，2026-09-24 用户拍板）。
            <BoardEmpty onCreate={() => setQuick({ target: 'BACKLOG' })} />
          ) : (
            <DndContext
              sensors={sensors}
              measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDragEnd={onDragEnd}
              onDragCancel={clearDrag}
            >
              {/* §5.2：LayoutGroup 圈定 layoutId 共享作用域——六列同组才有跨列飞行，
                  浮层/抽屉里的同名元素不会被卷进来。 */}
              <LayoutGroup>
                <ColumnRow>
                  {columns.map((column) => (
                    <BoardColumnView
                      key={column.status}
                      column={column}
                      defs={defs}
                      actions={actions}
                      overlayOf={overlayOf}
                      dropState={dropMap ? dropMap[column.status] : null}
                      isOver={overColumn === columnDropId(column.status)}
                      loading={false}
                      onDraggingChange={ignoreDragging}
                    />
                  ))}
                </ColumnRow>
              </LayoutGroup>
    
              {/* 3.3 + 1.6：拖起来的是卡片克隆体（旋转 2deg + `shadow-card-drag`），原位置留虚线占位。 */}
              <DragOverlay dropAnimation={{ duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
                {activeCard ? (
                  <BoardCardView
                    card={activeCard}
                    defs={defs}
                    overlay={overlayOf(activeCard.id)}
                    actions={actions}
                    asOverlay
                  />
                ) : null}
              </DragOverlay>
            </DndContext>
          )}
      </div>

      <QuickCreateDialog state={quick} mutations={mutations} onClose={closeQuick} />
      <StopDialog card={stopTarget} mutations={mutations} onClose={() => setStopTarget(null)} />
      <DeleteDialog card={deleteTarget} mutations={mutations} onClose={() => setDeleteTarget(null)} />
    </div>
  );
}

/* --------------------------------------------------------------- 动作集 */

type Setter<T> = (value: T) => void;

/**
 * 卡片的动作集（4.3 操作表）。`useMemo` 里通过 ref 取最新 mutation 结果：
 * mutation 对象每次渲染都是新的，直接进依赖会让 `actions` 每次都换身份，
 * 卡片上的 `memo` 就白写了（一次 WS 刷新要重渲上百张卡）。
 */
function useCardActions(
  toast: ToastApi,
  mutations: BoardMutations,
  setStopTarget: Setter<TaskCard | null>,
  setDeleteTarget: Setter<TaskCard | null>,
  setQuick: Setter<QuickCreateTarget | null>,
): CardActions {
  const latest = useRef(mutations);
  latest.current = mutations;

  return useMemo<CardActions>(() => {
    const shell = () => useShellStore.getState();
    const run = () => latest.current;
    return {
      open: (card) => shell().openTask(card.id),
      togglePin: (card) => run().togglePin.mutate(card),
      archive: (card) => run().archive.mutate(card.id),
      stop: (card) => setStopTarget(card),
      remove: (card) => setDeleteTarget(card),
      review: (card) => shell().openReview(card.id),
      followUp: (card) => setQuick({ target: 'BACKLOG', dependsOn: { id: card.id, title: card.title } }),
      create: (target, template) => setQuick({ target, preset: template?.preset }),
      copyId: (card) => {
        const write = navigator.clipboard?.writeText(card.id);
        if (!write) {
          toast.error('复制失败', `请手动选中 ${card.id}`);
          return;
        }
        void write.then(
          () => toast.success('已复制任务 ID', card.id),
          () => toast.error('复制失败', `请手动选中 ${card.id}`),
        );
      },
      /** 4.5 的三种反馈都在这一处：✅ 才发请求，🔒 弹表单，❌ 只 Toast。 */
      move: (card, to) => {
        const verdict = dropVerdict(card.status, to);
        if (verdict.kind === 'direct') {
          // §5.2 方案 A：用户发起的 ✅ 换列在此登记 pending-move（拖拽释放路径已被规则 5
          // 抑制）。旧列在快照回来前的每次渲染据此撤掉 exit、预挂 layoutId，
          // 数据落地同帧瞬时让位 → 新列挂载即飞行；服务端确认后标记过期，不再重放（§5.1）。
          markPendingMove(card.id, card.status, to);
          run().move.mutate({ id: card.id, to });
          return;
        }
        if (verdict.kind === 'form') {
          // 松手弹表单，取消即回原列：这一步没发过任何请求。
          if (verdict.form === 'stop') setStopTarget(card);
          else shell().openReview(card.id, reviewPrefillForDrop(to));
          return;
        }
        if (verdict.kind === 'forbidden') toast.warning('不允许的流转', verdict.copy);
      },
    };
  }, [setQuick, setStopTarget, setDeleteTarget, toast]);
}

/* --------------------------------------------------------------- 布局件 */

function ColumnRow({ children }: { children: ReactNode }) {
  // 3.1：纵向滚动在每列内部（列头 44px 固定）；B7 起列宽弹性等分，
  // `overflow-x-auto` 只在窗口窄到放不下全部列的最小宽+间距时兜底横滚。
  // §5.2 回落规则 2：滚动祖先是换列飞行的测量错位来源，`layoutScroll` 让 motion
  // 的投影在滚动后重测坐标（列内纵向滚动容器的同一 prop 在 board-column.tsx）。
  return (
    <motion.div
      layoutScroll
      className="atb-scroll flex min-h-0 flex-1 items-stretch gap-4 overflow-x-auto pb-2 pt-3"
    >
      {children}
    </motion.div>
  );
}

/** 3.6「看板整体无任务」。 */
function BoardEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <EmptyState
        icon={<span aria-hidden className="text-2xl leading-none">📋</span>}
        title="还没有任务"
        description="创建一个任务，让 Agent 来执行"
        action={
          <div className="flex items-center gap-2">
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={onCreate}>
              新建任务
            </Button>
            <Button variant="ghost" onClick={() => navigate('tasks')}>
              全部任务
            </Button>
          </div>
        }
      />
    </div>
  );
}

/* --------------------------------------------------------------- 小工具 */

function columnDropId(status: TaskStatus): string {
  return `column:${status}`;
}

/**
 * 4.5 末段 + 原型 3.7：`REVIEW → BACKLOG/READY` 是「驳回表单 + 退回目标＝拖放目标列」，
 * `REVIEW → DONE` 是「审核（结论预填通过）」。矩阵的 action 文案已经这么写，
 * 表单这边的预填由这一个映射喂，两处不再各判一次。
 */
function reviewPrefillForDrop(to: TaskStatus): ReviewPrefill | null {
  if (to === 'BACKLOG' || to === 'READY') return { conclusion: 'REJECT', returnTo: to };
  if (to === 'DONE') return { conclusion: 'APPROVE' };
  return null;
}

/** droppable id 反解出列状态；列外区域与卡片自身（不是 droppable）都会得到 null。 */
function columnStatusOf(id: string | null): TaskStatus | null {
  if (!id || !id.startsWith('column:')) return null;
  const raw = id.slice('column:'.length);
  return (COLUMN_ORDER as readonly string[]).includes(raw) ? (raw as TaskStatus) : null;
}

function emptyColumn(status: TaskStatus): BoardColumn {
  return { status, label: status, count: 0, has_more: false, tasks: [] };
}

/** 20.7：`columns` 固定 6 个元素、固定顺序；表外状态原样透传，缺列时补空列占位。 */
function mergeColumns(input?: BoardColumn[]): BoardColumn[] {
  const byStatus = new Map((input ?? []).map((column) => [column.status, column]));
  return COLUMN_ORDER.map((status) => byStatus.get(status) ?? emptyColumn(status));
}

/** 拖拽中的占位样式由 `useDraggable.isDragging` 自己给，页面级不需要再记一份。 */
function ignoreDragging(): void {}
