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
import { useShallow } from 'zustand/react/shallow';
import { CloudOff, Plus, RotateCcw } from 'lucide-react';
import type { BoardColumn, TaskCard, TaskStatus } from '@/api/types';
import { errorMessage, useFieldDefs } from '@/api';
import { navigate } from '@/app/router';
import { toBoardQuery, useFilterStore } from '@/app/store/filters';
import { useShellStore, type ReviewPrefill } from '@/app/store/shell';
import { Button, EmptyState, useToast, type ToastApi } from '@/components/ui';
import { useBoardWithProjects, useProjects } from '@/features/projects';
import { BoardColumnView } from './board-column';
import type { CardActions } from './card-actions';
import { DeleteDialog, StopDialog } from './dialogs';
import { GroupedBoard } from './grouped-board';
import { dropStates, dropVerdict } from './matrix';
import { COLUMN_ORDER, isDefaultBoardView } from './model';
import { useBoardMutations, type BoardMutations } from './mutations';
import { QuickCreateDialog, type QuickCreateTarget } from './quick-create';
import { BoardToolbar } from './toolbar';
import { toGroupable } from './grouping/dimensions';
import { applyLaneOrder, buildSwimlanes, filterLanes } from './grouping/grouping';
import { useGroupingStore } from './grouping/useGroupingState';
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
  // 整份筛选状态进依赖：`toBoardQuery` 每次调用都新建对象，不 memo 就等于每次渲染
  // 换一次 query key（每帧重取 `/board`）。
  const filters = useFilterStore();
  const params = useMemo(() => toBoardQuery(filters), [filters]);
  const defaultView = useMemo(() => isDefaultBoardView(filters), [filters]);

  // 7.8：项目多选 → 每个选中项目一次 `project_id` 服务端过滤请求、按六列合并（useProjectScoped）。
  const board = useBoardWithProjects(params);
  const fieldDefs = useFieldDefs();
  const defs = useMemo(() => fieldDefs.data?.items ?? [], [fieldDefs.data?.items]);
  const mutations = useBoardMutations();
  const { overlayOf } = useRunOverlay();

  const columns = useMemo(() => mergeColumns(board.data?.columns), [board.data?.columns]);
  const cards = useMemo(() => {
    const map = new Map<string, TaskCard>();
    for (const column of columns) for (const card of column.tasks) map.set(card.id, card);
    return map;
  }, [columns]);
  const total = columns.reduce((sum, column) => sum + column.tasks.length, 0);

  /* ------------------------------------------------------ 分组（泳道）接线 */

  // 分组偏好整体订阅（useShallow 按字段浅比较）；默认 primary='status' → 经典六列形态。
  const grouping = useGroupingStore(
    useShallow((state) => ({
      primary: state.primary,
      secondary: state.secondary,
      options: state.options,
      laneOrder: state.laneOrder,
      laneFilter: state.laneFilter,
      projectIds: state.projectIds,
      laneSort: state.laneSort,
    })),
  );
  const collapseAll = useGroupingStore((state) => state.collapseAll);
  /** 主分组不是「状态」时走泳道视图；「状态」维度即现有单维看板，不重复包一层泳道。 */
  const grouped = grouping.primary !== 'status';

  /** 六列快照拉平 + 接缝字段补齐（project / requirement 摘要）；项目名/色来自项目缓存。 */
  const projects = useProjects();
  const projectById = useMemo(
    () => new Map((projects.data?.items ?? []).map((project) => [project.id, project])),
    [projects.data?.items],
  );
  const groupableTasks = useMemo(
    () =>
      columns
        .flatMap((column) => column.tasks)
        .map(toGroupable)
        .map((task) => {
          const project = task.project_id ? projectById.get(task.project_id) : undefined;
          return project ? { ...task, project_name: project.name, project_color: project.color } : task;
        }),
    [columns, projectById],
  );
  // 4.5 多项目过滤已由服务端完成（useBoardWithProjects），这里不再前端截一遍。

  /** 泳道结构与 GroupedBoard 内部同一套纯函数；这里算一份供工具栏拿 laneKeys。 */
  const groupedLanes = useMemo(() => {
    if (!grouped) return [];
    const sorted = [...groupableTasks];
    if (grouping.laneSort === 'priority') sorted.sort((a, b) => a.priority - b.priority);
    else if (grouping.laneSort === 'updated_at')
      sorted.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
    let built = buildSwimlanes({
      tasks: sorted,
      primary: grouping.primary,
      secondary: grouping.secondary,
      showEmptyLanes: grouping.options.showEmptyLanes,
    });
    if (grouping.options.rememberOrder)
      built = applyLaneOrder(built, grouping.laneOrder[grouping.primary] ?? []);
    return filterLanes(built, grouping.laneFilter);
  }, [grouped, groupableTasks, grouping]);
  const laneKeys = useMemo(() => groupedLanes.map((lane) => lane.key), [groupedLanes]);

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
        grouping={{
          primary: grouping.primary,
          grouped,
          laneKeys,
          onToggleAll: (collapsed) => collapseAll(grouping.primary, laneKeys, collapsed),
        }}
      />

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
              defaultView
              dropState={null}
              isOver={false}
              loading
              onDraggingChange={ignoreDragging}
            />
          ))}
        </ColumnRow>
      ) : total === 0 && defaultView ? (
        // 3.6：只有「整张看板空」才替掉六列；筛选后的空态由折叠列 + 工具栏那句文案表达。
        <BoardEmpty onCreate={() => setQuick({ target: 'BACKLOG' })} />
      ) : grouped ? (
        // 7.3/7.4 泳道视图：主分组≠「状态」时走 GroupedBoard（含跨分组拖拽确认）。
        <GroupedBoard
          tasks={groupableTasks}
          defs={defs}
          actions={actions}
          mutations={mutations}
          overlayOf={overlayOf}
        />
      ) : (
        <DndContext
          sensors={sensors}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={clearDrag}
        >
          <ColumnRow>
            {columns.map((column) => (
              <BoardColumnView
                key={column.status}
                column={column}
                defs={defs}
                actions={actions}
                overlayOf={overlayOf}
                defaultView={defaultView}
                dropState={dropMap ? dropMap[column.status] : null}
                isOver={overColumn === columnDropId(column.status)}
                loading={false}
                onDraggingChange={ignoreDragging}
              />
            ))}
          </ColumnRow>

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
  // 3.1：整行横向滚动、列宽不压缩；纵向滚动在每列内部（列头 44px 固定）。
  return (
    <div className="atb-scroll flex min-h-0 flex-1 items-stretch gap-4 overflow-x-auto pb-2 pt-3">
      {children}
    </div>
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
